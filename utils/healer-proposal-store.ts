/**
 * Healer Proposal Store — 自愈建议的运行级持久化文件。
 *
 * Proposal 表示“AI 自愈结果需要人审查”，不是正式 Locator 资产：
 * - pending：AI 自愈成功，等待人工审核；
 * - approved：人工确认接受该建议；
 * - rejected：人工拒绝该建议；
 * - failed：AI 自愈失败或候选未通过校验，作为审计记录保留。
 *
 * 当前 MVP 使用 JSON 文件存储，默认路径为 test-results/healer-proposals.json。
 * 该文件属于运行产物，不应提交 Git；正式 Locator 只沉淀到 locator-store.json。
 *
 * 注意：globalSetup 会清空本文件，让每次测试运行从干净状态开始。
 * 后续如果要支持长时间异步审批，应把 Store 抽象到数据库、GitHub Issue 或按 runId 分文件的持久化方案。
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export type HealProposalStatus = 'pending' | 'approved' | 'rejected' | 'failed';

export type HealProposalAction = 'click' | 'assert' | 'fill' | 'locate';

export interface HealProposal {
  /** Proposal 的唯一 ID。飞书按钮回调会用它定位待处理建议。 */
  id: string;
  /** Proposal 创建时间，ISO 8601 格式。 */
  createdAt: string;
  /** 当前审核状态。只有 pending 允许转为 approved/rejected。 */
  status: HealProposalStatus;
  /** 一次测试运行的标识，便于和事件、报告、Jenkins 构建关联。 */
  runId?: string;
  /** 触发自愈的测试用例标题。 */
  testName?: string;
  /** 触发自愈的测试文件路径。 */
  testFile?: string;
  /** 触发自愈时所在页面 URL。 */
  pageUrl?: string;
  /** locator-store.json 中的 key。正式更新只允许改这个 key 对应的值。 */
  locatorKey: string;
  /** 给审核人看的业务化元素名称，例如“批量确认按钮”。 */
  elementName: string;
  /** 触发自愈的动作类型。不同动作会走不同 Quality Gate。 */
  action: HealProposalAction;
  /** 原始失败 Locator。 */
  oldLocator: string;
  /** AI 建议的新 Locator。存在该字段时，初始状态为 pending。 */
  newLocator?: string;
  /** AI 返回的置信度，范围 0.0–1.0。 */
  confidence?: number;
  /** AI 给出的修复理由，用于飞书卡片和 PR 描述。 */
  reason?: string;
  /** 自愈失败详情。没有 newLocator 时，初始状态为 failed。 */
  errorDetail?: string;
}

const DEFAULT_PROPOSAL_DIR = path.resolve(process.cwd(), 'test-results');
const DEFAULT_PROPOSAL_FILE = path.join(DEFAULT_PROPOSAL_DIR, 'healer-proposals.json');

function getProposalFile(): string {
  // 单测或本地实验可通过 HEALER_PROPOSAL_PATH 指向临时文件，避免污染真实运行产物。
  return process.env.HEALER_PROPOSAL_PATH || DEFAULT_PROPOSAL_FILE;
}

function ensureDir(file: string): void {
  const dir = path.dirname(file);
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * 清空本轮运行的 Proposal 文件。
 *
 * 该函数由 globalSetup 调用。这样做可以避免上一轮测试的待审核数据污染本轮结果，
 * 但也意味着当前 JSON 文件方案不适合“跨多轮运行长期等待审批”的场景。
 */
export function clearProposals(): void {
  const file = getProposalFile();
  ensureDir(file);
  fs.writeFileSync(file, '[]', 'utf-8');
}

/**
 * 读取本轮运行的所有 Proposal。
 *
 * 读取失败时返回空数组并打印 warning，避免 reporter 因运行产物损坏导致整个测试报告流程崩溃。
 */
export function readProposals(): HealProposal[] {
  const file = getProposalFile();
  if (!fs.existsSync(file)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(file, 'utf-8').trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HealProposal[]) : [];
  } catch (err) {
    console.warn('[healer-proposal-store] failed to read proposals:', err);
    return [];
  }
}

function persist(proposals: HealProposal[]): void {
  const file = getProposalFile();
  ensureDir(file);
  fs.writeFileSync(file, JSON.stringify(proposals, null, 2), 'utf-8');
}

/**
 * 新增一条自愈建议。
 *
 * 状态推导规则：
 * - 有 newLocator：表示 AI 自愈成功且通过校验，进入 pending，等待人工审核；
 * - 无 newLocator：表示自愈失败或没有可用候选，进入 failed，作为审计记录。
 *
 * 去重规则：同一轮运行中，相同 locatorKey + oldLocator + newLocator 的 pending 建议只保留一条，
 * 避免多个用例因为同一个定位器失效而刷屏飞书审核卡。
 */
export function addProposal(
  proposal: Omit<HealProposal, 'id' | 'createdAt' | 'status'>
): HealProposal {
  const proposals = readProposals();

  const hasNewLocator = Boolean(proposal.newLocator);

  if (hasNewLocator) {
    const existing = proposals.find(
      (p) =>
        p.status === 'pending' &&
        p.locatorKey === proposal.locatorKey &&
        p.oldLocator === proposal.oldLocator &&
        p.newLocator === proposal.newLocator
    );
    if (existing) {
      return existing;
    }
  }

  const full: HealProposal = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    status: hasNewLocator ? 'pending' : 'failed',
    ...proposal,
  };

  proposals.push(full);
  persist(proposals);
  return full;
}

/**
 * 更新 Proposal 审核状态。
 *
 * 只允许 pending → approved/rejected。
 * 如果 Proposal 已经是终态，则直接返回原对象，保证飞书重复点击、网络重试等场景下具备幂等性。
 */
export function updateProposalStatus(
  proposalId: string,
  status: 'approved' | 'rejected'
): HealProposal {
  const proposals = readProposals();
  const target = proposals.find((p) => p.id === proposalId);
  if (!target) {
    throw new Error(`Proposal not found: ${proposalId}`);
  }

  if (target.status !== 'pending') {
    return target;
  }

  target.status = status;
  persist(proposals);
  return target;
}

/** 返回 Proposal 文件绝对路径，便于日志、调试脚本或测试断言使用。 */
export function getProposalFilePath(): string {
  return getProposalFile();
}
