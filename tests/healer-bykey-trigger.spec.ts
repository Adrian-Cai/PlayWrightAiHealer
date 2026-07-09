import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { assertVisibleByKey, healCache, healEventBus } from '../utils/ai-healer';
import { setMockOpenAIClient } from '../utils/openai-client';
import { clearProposals, readProposals } from '../utils/healer-proposal-store';

const TMP_STORE = path.join(__dirname, '.tmp-trigger-store.json');
const TMP_PROPOSALS = path.join(__dirname, '.tmp-trigger-proposals.json');

test.beforeEach(() => {
  fs.writeFileSync(
    TMP_STORE,
    JSON.stringify({ submitButton: '#old-submit' }, null, 2),
    'utf-8'
  );
  if (fs.existsSync(TMP_PROPOSALS)) fs.unlinkSync(TMP_PROPOSALS);
  process.env.LOCATOR_STORE_PATH = TMP_STORE;
  process.env.HEALER_PROPOSAL_PATH = TMP_PROPOSALS;
  clearProposals();
  healCache.clear();
  healEventBus.clear();
});

test.afterEach(() => {
  delete process.env.LOCATOR_STORE_PATH;
  delete process.env.HEALER_PROPOSAL_PATH;
  if (fs.existsSync(TMP_STORE)) fs.unlinkSync(TMP_STORE);
  if (fs.existsSync(TMP_PROPOSALS)) fs.unlinkSync(TMP_PROPOSALS);
  setMockOpenAIClient(null);
  healEventBus.clear();
});

test('assertVisibleByKey heals a missing locator and records a review proposal', async ({ page }, testInfo) => {
  setMockOpenAIClient(async () => ({
    locator: '#new-submit',
    strategy: 'css',
    confidence: 0.94,
    reason: 'button id changed',
  }));

  await page.setContent('<button id="new-submit">Submit</button>');

  await assertVisibleByKey(page, 'submitButton', 'submit button', testInfo, {
    timeout: 100,
  });

  const proposals = readProposals();
  expect(proposals).toHaveLength(1);
  expect(proposals[0]).toMatchObject({
    status: 'pending',
    locatorKey: 'submitButton',
    oldLocator: '#old-submit',
    newLocator: '#new-submit',
  });
});

test('assertVisibleByKey reports missing AI provider clearly when healing cannot start', async ({ page }, testInfo) => {
  const oldDeepSeekKey = process.env.DEEPSEEK_API_KEY;
  const oldOpenAIKey = process.env.OPENAI_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.OPENAI_API_KEY;
  setMockOpenAIClient(null);

  try {
    await page.setContent('<button id="other">Other</button>');

    await expect(
      assertVisibleByKey(page, 'submitButton', 'submit button', testInfo, {
        timeout: 100,
      })
    ).rejects.toThrow(/Heal failed: Neither DEEPSEEK_API_KEY nor OPENAI_API_KEY/);
  } finally {
    if (oldDeepSeekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = oldDeepSeekKey;
    if (oldOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldOpenAIKey;
  }
});
