/**
 * Healer Review Actions — 飞书审批按钮背后的纯业务逻辑。
 *
 * 本文件从 scripts/feishu-callback-server.js 中拆出来，目的是让审批逻辑可以单测，
 * 同时让回调服务只做“SDK 适配 + 消息反馈”，不承载业务状态流转。
 *
 * 当前 MVP 语义：
 * - approve：人工接受 AI 候选 Locator，更新 locator-store.json，并把 Proposal 标记为 approved；
 * - reject：人工拒绝该候选 Locator，只更新 Proposal 状态，不修改 locator-store.json；
 * - 非 pending 的 Proposal 不能重复处理，避免飞书重复点击或网络重试导致重复写入。
 *
 * 安全边界：
 * - HEALER_CALLBACK_TOKEN 是 SDK 长连接签名校验之外的额外防线；
 * - 未配置 token 时允许开发环境直接依赖 SDK 签名校验；
 * - 本文件不负责创建 PR。PR 创建由回调服务在 approve 成功后按 HEALER_AUTO_PR 决定是否触发。
 */

import { readProposals, updateProposalStatus, HealProposal } from './healer-proposal-store';
import { updateLocator } from './locator-repository';

export type CallbackAction = 'approve_locator' | 'reject_locator';

export interface CallbackValue {
  /** 飞书按钮动作类型。 */
  action: CallbackAction;
  /** 飞书卡片中携带的 Proposal ID，用于定位待审核建议。 */
  proposalId: string;
  /** 可选共享密钥；配置 HEALER_CALLBACK_TOKEN 后必须匹配。 */
  token?: string;
}

export type ReviewOutcome =
  | { ok: true; action: CallbackAction; proposal: HealProposal; message: string }
  | { ok: false; error: string };

/**
 * 校验飞书卡片按钮携带的共享密钥。
 *
 * 说明：飞书长连接 SDK 已做来源校验；这里的 token 是 defense-in-depth。
 * 开发期不配置 HEALER_CALLBACK_TOKEN 时跳过校验，便于首次联调。
 */
export function validateCallbackToken(value: CallbackValue): boolean {
  const expected = process.env.HEALER_CALLBACK_TOKEN;
  if (!expected) {
    return true;
  }
  return value.token === expected;
}

/**
 * 解析飞书 card.action.trigger 的 action.value。
 *
 * 返回 null 表示 payload 形状不可信，回调服务应忽略该事件而不是继续执行审批动作。
 */
export function parseCallbackValue(raw: unknown): CallbackValue | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  const action = v.action;
  const proposalId = v.proposalId;

  if (
    (action !== 'approve_locator' && action !== 'reject_locator') ||
    typeof proposalId !== 'string' ||
    proposalId.length === 0
  ) {
    return null;
  }

  return {
    action,
    proposalId,
    token: typeof v.token === 'string' ? v.token : undefined,
  };
}

/**
 * 批准一个 Locator 修复建议。
 *
 * 当前行为会直接更新 locator-store.json，这是 MVP 的轻量实现。
 * 如果后续演进为 GitHub PR 模式，建议把这里改成“标记 approved”，再由 PR Provider 在分支上修改 locator-store.json。
 */
export function approveLocatorProposal(proposalId: string): ReviewOutcome {
  const proposals = readProposals();
  const proposal = proposals.find((p) => p.id === proposalId);

  if (!proposal) {
    return { ok: false, error: `未找到修复建议: ${proposalId}` };
  }

  if (proposal.status !== 'pending') {
    return {
      ok: false,
      error: `该建议已处理过（当前状态: ${proposal.status}），无需重复操作`,
    };
  }

  if (!proposal.newLocator) {
    return { ok: false, error: '该建议没有新定位器（自愈失败项不可批准）' };
  }

  try {
    // 只允许更新已存在 key；locator-repository 会拒绝新增 key，避免审批回调偷偷引入新定位器资产。
    updateLocator(proposal.locatorKey, proposal.newLocator);
  } catch (err: any) {
    return { ok: false, error: `更新 locator-store.json 失败: ${err.message}` };
  }

  const updated = updateProposalStatus(proposalId, 'approved');
  return {
    ok: true,
    action: 'approve_locator',
    proposal: updated,
    message: `✅ 已替换定位器 [${proposal.locatorKey}]\n${proposal.oldLocator} → ${proposal.newLocator}`,
  };
}

/**
 * 拒绝一个 Locator 修复建议。
 *
 * reject 只改变 Proposal 状态，不修改 locator-store.json，也不触发 PR。
 */
export function rejectLocatorProposal(proposalId: string): ReviewOutcome {
  const proposals = readProposals();
  const proposal = proposals.find((p) => p.id === proposalId);

  if (!proposal) {
    return { ok: false, error: `未找到修复建议: ${proposalId}` };
  }

  if (proposal.status !== 'pending') {
    return {
      ok: false,
      error: `该建议已处理过（当前状态: ${proposal.status}），无需重复操作`,
    };
  }

  const updated = updateProposalStatus(proposalId, 'rejected');
  return {
    ok: true,
    action: 'reject_locator',
    proposal: updated,
    message: `❌ 已拒绝修复建议 [${proposal.locatorKey}]`,
  };
}

/**
 * 审批动作总入口。
 *
 * 回调服务只需要把解析后的 CallbackValue 传进来，本函数负责 token 校验和动作分发。
 */
export function handleReviewCallback(value: CallbackValue): ReviewOutcome {
  if (!validateCallbackToken(value)) {
    return { ok: false, error: '回调 token 校验失败' };
  }

  if (value.action === 'approve_locator') {
    return approveLocatorProposal(value.proposalId);
  }
  return rejectLocatorProposal(value.proposalId);
}
