/**
 * Playwright Global Teardown — finalizes heal system after tests
 * No chatty Feishu end message; FeishuReporter sends a single summary at onEnd.
 */

import { healCache } from './utils/heal-cache';

async function globalTeardown(): Promise<void> {
  console.log('[GlobalTeardown] Finalizing heal system...');

  // Log cache stats to console (no Feishu message — reporter handles end-of-run summary)
  const stats = healCache.stats();
  console.log(`[GlobalTeardown] Heal cache stats: ${stats.size} entries`);

  console.log('[GlobalTeardown] Heal system finalized');
}

export default globalTeardown;
