/**
 * Unit tests for healer-proposal-store.ts
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import {
  clearProposals,
  addProposal,
  readProposals,
  updateProposalStatus,
  getProposalFilePath,
  HealProposal,
} from '../utils/healer-proposal-store';

const TMP = path.join(__dirname, '.tmp-healer-proposals.spec.json');

test.beforeEach(() => {
  if (fs.existsSync(TMP)) fs.unlinkSync(TMP);
  process.env.HEALER_PROPOSAL_PATH = TMP;
  clearProposals();
});

test.afterEach(() => {
  delete process.env.HEALER_PROPOSAL_PATH;
  if (fs.existsSync(TMP)) fs.unlinkSync(TMP);
});

const basePending = {
  locatorKey: 'batchConfirmButton',
  elementName: '批量确认按钮',
  action: 'click' as const,
  oldLocator: 'text=批量确认',
  newLocator: 'button:has-text("批量确认")',
  confidence: 0.9,
  reason: 'mock',
};

test('clearProposals starts with an empty file', () => {
  expect(readProposals()).toHaveLength(0);
});

test('addProposal records a pending proposal when newLocator is present', () => {
  const p = addProposal(basePending);
  expect(p.id).toBeTruthy();
  expect(p.status).toBe('pending');
  expect(p.createdAt).toBeTruthy();
  expect(readProposals()).toHaveLength(1);
});

test('addProposal records a failed proposal when newLocator is absent', () => {
  const p = addProposal({ ...basePending, newLocator: undefined, errorDetail: 'boom' });
  expect(p.status).toBe('failed');
  expect(p.errorDetail).toBe('boom');
});

test('addProposal dedupes pending proposals by (locatorKey + oldLocator + newLocator)', () => {
  const first = addProposal(basePending);
  const second = addProposal(basePending);
  expect(second.id).toBe(first.id);
  expect(readProposals()).toHaveLength(1);
});

test('addProposal does NOT dedupe failed proposals', () => {
  addProposal({ ...basePending, newLocator: undefined, errorDetail: 'err1' });
  addProposal({ ...basePending, newLocator: undefined, errorDetail: 'err2' });
  expect(readProposals()).toHaveLength(2);
});

test('addProposal treats different newLocator as distinct proposals', () => {
  addProposal({ ...basePending, newLocator: 'button:has-text("批量确认")' });
  addProposal({ ...basePending, newLocator: '[role=button]:has-text("批量确认")' });
  expect(readProposals()).toHaveLength(2);
});

test('updateProposalStatus transitions pending → approved', () => {
  const p = addProposal(basePending);
  const updated = updateProposalStatus(p.id, 'approved');
  expect(updated.status).toBe('approved');
  expect(readProposals()[0].status).toBe('approved');
});

test('updateProposalStatus transitions pending → rejected', () => {
  const p = addProposal(basePending);
  updateProposalStatus(p.id, 'rejected');
  expect(readProposals()[0].status).toBe('rejected');
});

test('updateProposalStatus throws on unknown id', () => {
  expect(() => updateProposalStatus('does-not-exist', 'approved')).toThrow(/Proposal not found/);
});

test('updateProposalStatus is idempotent on already-terminal proposals', () => {
  const p = addProposal(basePending);
  updateProposalStatus(p.id, 'approved');
  // Second call should NOT throw and should return approved status
  const again = updateProposalStatus(p.id, 'rejected');
  expect(again.status).toBe('approved'); // stays approved, not flipped to rejected
});

test('getProposalFilePath respects HEALER_PROPOSAL_PATH override', () => {
  expect(getProposalFilePath()).toBe(TMP);
});
