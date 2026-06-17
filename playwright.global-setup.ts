/**
 * Playwright Global Setup — initializes heal system before tests
 * No chatty Feishu start message; FeishuReporter sends a single summary at onEnd.
 */

import { initFeishuBot } from './utils/feishu-bot';
import { initHealerCollector, clearHealEvents } from './utils/healer-collector';

async function globalSetup(): Promise<void> {
  console.log('[GlobalSetup] Initializing heal system...');

  // Clear JSONL event sink so this run starts fresh
  clearHealEvents();

  // Subscribe JSONL collector to heal events
  initHealerCollector();

  // Initialize Feishu bot subscriptions
  initFeishuBot();

  console.log('[GlobalSetup] Heal system initialized (no Feishu start message)');
}

export default globalSetup;
