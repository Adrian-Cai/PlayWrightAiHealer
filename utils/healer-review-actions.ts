/**
 * Healer Review Actions — Pure functions for approve/reject locator proposals
 *
 * Extracted from the callback server so the core logic is unit-testable without
 * spinning up the Feishu WebSocket long-connection. The callback server
 * (scripts/feishu-callback-server.js) is a thin SDK adapter that calls these.
 *
 * Security:
 *   - validateCallbackToken() checks the shared secret carried in the button
 *     value. This is a defense-in-depth layer on top of the SDK's built-in
 *     signature verification (long-connection mode verifies the WS frame
 *     origin internally).
 *   - approveLocatorProposal refuses to act on non-pending proposals
 *     (idempotent guard lives in updateProposalStatus).
 */

import { readProposals, updateProposalStatus, HealProposal } from './healer-proposal-store';
import { updateLocator } from './locator-repository';

export type CallbackAction = 'approve_locator' | 'reject_locator';

export interface CallbackValue {
  action: CallbackAction;
  proposalId: string;
  token?: string;
}

export type ReviewOutcome =
  | { ok: true; action: CallbackAction; proposal: HealProposal; message: string }
  | { ok: false; error: string };

/**
 * Validate the callback token against HEALER_CALLBACK_TOKEN.
 * - If HEALER_CALLBACK_TOKEN is unset, token check is SKIPPED (open mode,
 *   relies solely on SDK signature verification — useful for first-run dev).
 * - If HEALER_CALLBACK_TOKEN is set, the value.token MUST match.
 */
export function validateCallbackToken(value: CallbackValue): boolean {
  const expected = process.env.HEALER_CALLBACK_TOKEN;
  if (!expected) {
    // No shared secret configured → rely on SDK signature verification only.
    return true;
  }
  return value.token === expected;
}

/**
 * Parse and validate the raw action.value payload from a Feishu card button.
 * Returns null if the shape is invalid.
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
 * Apply an approve action: replace the locator in locator-store.json and
 * mark the proposal as approved.
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
 * Apply a reject action: mark the proposal as rejected. locator-store.json
 * is NOT modified.
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
 * Top-level dispatcher used by the callback server. Performs token check,
 * then routes to approve/reject.
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
