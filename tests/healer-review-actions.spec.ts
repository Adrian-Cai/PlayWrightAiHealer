/**
 * Unit tests for healer-review-actions.ts (Phase 3 callback logic)
 *
 * These test the pure approve/reject logic WITHOUT the Feishu SDK / WebSocket.
 * The callback server (scripts/feishu-callback-server.js) is just a thin SDK
 * adapter over these functions.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import {
  parseCallbackValue,
  validateCallbackToken,
  approveLocatorProposal,
  rejectLocatorProposal,
  handleReviewCallback,
} from '../utils/healer-review-actions';
import {
  clearProposals,
  addProposal,
  readProposals,
} from '../utils/healer-proposal-store';
import { getLocator } from '../utils/locator-repository';

const TMP_STORE = path.join(__dirname, '.tmp-review-store.json');
const TMP_PROPOSALS = path.join(__dirname, '.tmp-review-proposals.json');

const PENDING_PROPOSAL = {
  locatorKey: 'batchConfirmButton',
  elementName: '批量确认按钮',
  action: 'click' as const,
  oldLocator: 'text=批量确认',
  newLocator: 'button:has-text("批量确认")',
  confidence: 0.9,
  reason: 'mock',
};

function seedStore() {
  fs.writeFileSync(
    TMP_STORE,
    JSON.stringify({ batchConfirmButton: 'text=批量确认' }, null, 2),
    'utf-8'
  );
}

test.beforeEach(() => {
  if (fs.existsSync(TMP_STORE)) fs.unlinkSync(TMP_STORE);
  if (fs.existsSync(TMP_PROPOSALS)) fs.unlinkSync(TMP_PROPOSALS);
  process.env.LOCATOR_STORE_PATH = TMP_STORE;
  process.env.HEALER_PROPOSAL_PATH = TMP_PROPOSALS;
  seedStore();
  clearProposals();
  delete process.env.HEALER_CALLBACK_TOKEN;
});

test.afterEach(() => {
  delete process.env.LOCATOR_STORE_PATH;
  delete process.env.HEALER_PROPOSAL_PATH;
  delete process.env.HEALER_CALLBACK_TOKEN;
  if (fs.existsSync(TMP_STORE)) fs.unlinkSync(TMP_STORE);
  if (fs.existsSync(TMP_PROPOSALS)) fs.unlinkSync(TMP_PROPOSALS);
});

// --- parseCallbackValue ---

test('parseCallbackValue accepts a valid approve payload', () => {
  const v = parseCallbackValue({ action: 'approve_locator', proposalId: 'abc', token: 't' });
  expect(v).not.toBeNull();
  expect(v!.action).toBe('approve_locator');
  expect(v!.proposalId).toBe('abc');
});

test('parseCallbackValue accepts a valid reject payload', () => {
  const v = parseCallbackValue({ action: 'reject_locator', proposalId: 'abc' });
  expect(v).not.toBeNull();
  expect(v!.action).toBe('reject_locator');
});

test('parseCallbackValue rejects unknown action', () => {
  expect(parseCallbackValue({ action: 'delete_everything', proposalId: 'abc' })).toBeNull();
});

test('parseCallbackValue rejects missing proposalId', () => {
  expect(parseCallbackValue({ action: 'approve_locator' })).toBeNull();
});

test('parseCallbackValue rejects non-object input', () => {
  expect(parseCallbackValue(null)).toBeNull();
  expect(parseCallbackValue('string')).toBeNull();
  expect(parseCallbackValue(undefined)).toBeNull();
});

// --- validateCallbackToken ---

test('validateCallbackToken passes when HEALER_CALLBACK_TOKEN is unset (open mode)', () => {
  expect(validateCallbackToken({ action: 'approve_locator', proposalId: 'x' })).toBe(true);
});

test('validateCallbackToken passes when token matches', () => {
  process.env.HEALER_CALLBACK_TOKEN = 'secret';
  expect(
    validateCallbackToken({ action: 'approve_locator', proposalId: 'x', token: 'secret' })
  ).toBe(true);
});

test('validateCallbackToken fails when token mismatches', () => {
  process.env.HEALER_CALLBACK_TOKEN = 'secret';
  expect(
    validateCallbackToken({ action: 'approve_locator', proposalId: 'x', token: 'wrong' })
  ).toBe(false);
});

test('validateCallbackToken fails when token missing but expected', () => {
  process.env.HEALER_CALLBACK_TOKEN = 'secret';
  expect(validateCallbackToken({ action: 'approve_locator', proposalId: 'x' })).toBe(false);
});

// --- approveLocatorProposal ---

test('approveLocatorProposal replaces locator in store and marks proposal approved', () => {
  const p = addProposal(PENDING_PROPOSAL);
  const outcome = approveLocatorProposal(p.id);
  expect(outcome.ok).toBe(true);
  if (outcome.ok) {
    expect(outcome.action).toBe('approve_locator');
    expect(outcome.message).toContain('batchConfirmButton');
  }
  // locator-store.json updated
  expect(getLocator('batchConfirmButton')).toBe('button:has-text("批量确认")');
  // proposal status updated
  expect(readProposals()[0].status).toBe('approved');
});

test('approveLocatorProposal fails for unknown proposal id', () => {
  const outcome = approveLocatorProposal('does-not-exist');
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.error).toContain('未找到');
});

test('approveLocatorProposal is idempotent: second call on approved proposal fails gracefully', () => {
  const p = addProposal(PENDING_PROPOSAL);
  approveLocatorProposal(p.id);
  const second = approveLocatorProposal(p.id);
  expect(second.ok).toBe(false);
  if (!second.ok) expect(second.error).toContain('已处理过');
});

test('approveLocatorProposal refuses a failed (no newLocator) proposal', () => {
  const p = addProposal({ ...PENDING_PROPOSAL, newLocator: undefined, errorDetail: 'boom' });
  // A failed proposal has status 'failed' (not 'pending'), so approve is
  // rejected up-front by the status guard rather than the newLocator check.
  const outcome = approveLocatorProposal(p.id);
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.error).toContain('已处理过');
});

// --- rejectLocatorProposal ---

test('rejectLocatorProposal marks proposal rejected WITHOUT touching locator-store', () => {
  const p = addProposal(PENDING_PROPOSAL);
  const outcome = rejectLocatorProposal(p.id);
  expect(outcome.ok).toBe(true);
  // locator-store.json unchanged
  expect(getLocator('batchConfirmButton')).toBe('text=批量确认');
  expect(readProposals()[0].status).toBe('rejected');
});

test('rejectLocatorProposal fails for unknown proposal id', () => {
  const outcome = rejectLocatorProposal('nope');
  expect(outcome.ok).toBe(false);
});

// --- handleReviewCallback (top-level dispatcher) ---

test('handleReviewCallback routes approve correctly', () => {
  const p = addProposal(PENDING_PROPOSAL);
  const outcome = handleReviewCallback({ action: 'approve_locator', proposalId: p.id });
  expect(outcome.ok).toBe(true);
  expect(getLocator('batchConfirmButton')).toBe('button:has-text("批量确认")');
});

test('handleReviewCallback routes reject correctly', () => {
  const p = addProposal(PENDING_PROPOSAL);
  const outcome = handleReviewCallback({ action: 'reject_locator', proposalId: p.id });
  expect(outcome.ok).toBe(true);
  expect(getLocator('batchConfirmButton')).toBe('text=批量确认');
});

test('handleReviewCallback rejects on token mismatch', () => {
  process.env.HEALER_CALLBACK_TOKEN = 'secret';
  const p = addProposal(PENDING_PROPOSAL);
  const outcome = handleReviewCallback({
    action: 'approve_locator',
    proposalId: p.id,
    token: 'wrong',
  });
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.error).toContain('token');
  // locator-store untouched
  expect(getLocator('batchConfirmButton')).toBe('text=批量确认');
});

test('handleReviewCallback with correct token succeeds', () => {
  process.env.HEALER_CALLBACK_TOKEN = 'secret';
  const p = addProposal(PENDING_PROPOSAL);
  const outcome = handleReviewCallback({
    action: 'approve_locator',
    proposalId: p.id,
    token: 'secret',
  });
  expect(outcome.ok).toBe(true);
  expect(getLocator('batchConfirmButton')).toBe('button:has-text("批量确认")');
});
