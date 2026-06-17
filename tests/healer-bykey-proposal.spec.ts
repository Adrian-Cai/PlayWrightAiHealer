/**
 * Phase 2 verification: aiClickByKey / aiAssertByKey record HealProposal entries
 * on heal success and heal failure. Uses the broken-page fixture + mocked AI
 * (no network, no real AI key needed).
 */

import { test, expect } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import { aiClickByKey, aiAssertByKey, healCache } from '../utils/ai-healer';
import { setMockOpenAIClient } from '../utils/openai-client';
import {
  clearProposals,
  readProposals,
} from '../utils/healer-proposal-store';

const FIXTURE = path.resolve(__dirname, 'fixtures', 'broken-page.html');
const FIXTURE_URL = `file://${FIXTURE}`;

const TMP_STORE = path.join(__dirname, '.tmp-bykey-store.json');
const TMP_PROPOSALS = path.join(__dirname, '.tmp-bykey-proposals.json');

test.beforeEach(() => {
  // Isolate locator-store + proposals into temp files
  if (fs.existsSync(TMP_STORE)) fs.unlinkSync(TMP_STORE);
  if (fs.existsSync(TMP_PROPOSALS)) fs.unlinkSync(TMP_PROPOSALS);
  fs.writeFileSync(
    TMP_STORE,
    JSON.stringify(
      {
        // Deliberately broken: fixture uses .new-menu-item, not .ant-menu-item
        manualConfirmMenu: '.ant-menu-item:has-text("人工确认")',
        batchConfirmButton: '.ant-btn:has-text("批量确认")',
      },
      null,
      2
    ),
    'utf-8'
  );
  process.env.LOCATOR_STORE_PATH = TMP_STORE;
  process.env.HEALER_PROPOSAL_PATH = TMP_PROPOSALS;
  clearProposals();
  // Ensure no stale cache hit short-circuits the heal
  healCache.clear();
});

test.afterEach(() => {
  delete process.env.LOCATOR_STORE_PATH;
  delete process.env.HEALER_PROPOSAL_PATH;
  if (fs.existsSync(TMP_STORE)) fs.unlinkSync(TMP_STORE);
  if (fs.existsSync(TMP_PROPOSALS)) fs.unlinkSync(TMP_PROPOSALS);
  setMockOpenAIClient(null);
});

test('aiClickByKey records a pending proposal on heal success', async ({ page }, testInfo) => {
  setMockOpenAIClient(async () => ({
    locator: '[data-testid="manual-confirm"]',
    strategy: 'css' as const,
    confidence: 0.95,
    reason: 'fixture renamed ant-menu-item to new-menu-item; use testid',
  }));

  await page.goto(FIXTURE_URL);

  await aiClickByKey(page, 'manualConfirmMenu', '人工确认菜单项', testInfo);

  const proposals = readProposals();
  expect(proposals).toHaveLength(1);
  const p = proposals[0];
  expect(p.status).toBe('pending');
  expect(p.locatorKey).toBe('manualConfirmMenu');
  expect(p.oldLocator).toBe('.ant-menu-item:has-text("人工确认")');
  expect(p.newLocator).toBe('[data-testid="manual-confirm"]');
  expect(p.confidence).toBeCloseTo(0.95);
  expect(p.testName).toBe(testInfo.title);
});

test('aiClickByKey dedupes proposals when the same key fails twice', async ({ page }, testInfo) => {
  setMockOpenAIClient(async () => ({
    locator: '[data-testid="manual-confirm"]',
    strategy: 'css' as const,
    confidence: 0.95,
    reason: 'same heal twice',
  }));

  await page.goto(FIXTURE_URL);

  await aiClickByKey(page, 'manualConfirmMenu', '人工确认菜单项', testInfo);
  // Second call: original locator still broken, but cache hit → no new AI call,
  // no new proposal (dedupe by locatorKey + oldLocator + newLocator).
  // Reload to reset page state so click works again.
  await page.goto(FIXTURE_URL);
  await aiClickByKey(page, 'manualConfirmMenu', '人工确认菜单项', testInfo);

  const proposals = readProposals();
  // Still 1 — deduped
  expect(proposals).toHaveLength(1);
  expect(proposals[0].status).toBe('pending');
});

test('aiAssertByKey writes NO proposal when the original locator is valid', async ({ page }, testInfo) => {
  // NOTE: aiAssert uses locator.isVisible() which returns false (not throws) when
  // an element is absent, so the heal path is only reached when isVisible throws
  // (e.g. strict-mode violations). This test covers the happy path: valid locator
  // → no heal → no proposal. The "heal on assert failure" path is exercised in
  // the gated integration suite.
  setMockOpenAIClient(async () => ({
    locator: '[data-testid="batch-confirm"]',
    strategy: 'css' as const,
    confidence: 0.9,
    reason: 'should not be called',
  }));

  // Use a VALID locator for the key so assert succeeds without healing
  fs.writeFileSync(
    TMP_STORE,
    JSON.stringify({ batchConfirmButton: '[data-testid="batch-confirm"]' }, null, 2),
    'utf-8'
  );

  await page.goto(FIXTURE_URL);
  await page.click('[data-testid="manual-confirm"]');

  await aiAssertByKey(page, 'batchConfirmButton', '批量确认按钮', testInfo);

  const proposals = readProposals();
  expect(proposals).toHaveLength(0);
});

test('aiClickByKey records a failed proposal and re-throws original error when heal fails', async ({ page }, testInfo) => {
  // Mock returns a locator that does NOT exist on the page → Quality Gate fails
  setMockOpenAIClient(async () => ({
    locator: '#does-not-exist-anywhere',
    strategy: 'css' as const,
    confidence: 0.9,
    reason: 'hallucinated',
  }));

  await page.goto(FIXTURE_URL);

  await expect(
    aiClickByKey(page, 'manualConfirmMenu', '人工确认菜单项', testInfo)
  ).rejects.toThrow();

  const proposals = readProposals();
  expect(proposals).toHaveLength(1);
  expect(proposals[0].status).toBe('failed');
  expect(proposals[0].newLocator).toBeUndefined();
  expect(proposals[0].errorDetail).toBeTruthy();
});
