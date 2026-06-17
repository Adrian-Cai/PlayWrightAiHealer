/**
 * Playwright Global Setup — initializes heal system before tests
 * No chatty Feishu start message; FeishuReporter sends a single summary at onEnd.
 */

import { initFeishuBot } from './utils/feishu-bot';
import { initHealerCollector, clearHealEvents } from './utils/healer-collector';
import { clearProposals } from './utils/healer-proposal-store';
import { healCache } from './utils/heal-cache';

async function globalSetup(): Promise<void> {
  console.log('[GlobalSetup] Initializing heal system...');

  // Clear JSONL event sink so this run starts fresh
  clearHealEvents();

  // Clear pending proposals so each run starts fresh
  // (proposals are run-scoped; approved ones land in locator-store.json permanently)
  clearProposals();

  // Clear the cross-run heal cache so AI-suggested locators do NOT silently
  // persist across runs and bypass human review. The cache still works as an
  // in-run dedupe (same key healed twice in one run reuses the result).
  // Without this, a healed locator would auto-apply on the next run within
  // the cache TTL, defeating the review workflow.
  healCache.clear();

  // Subscribe JSONL collector to heal events
  initHealerCollector();

  // Initialize Feishu bot subscriptions
  initFeishuBot();

  console.log('[GlobalSetup] Heal system initialized (no Feishu start message)');
}

export default globalSetup;
