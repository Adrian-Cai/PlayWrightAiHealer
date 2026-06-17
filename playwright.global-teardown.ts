/**
 * Playwright Global Teardown — finalizes heal system after tests
 * Sends END notification, flushes caches
 */

import { healCache } from './utils/heal-cache';
import { sendFeishuMessage } from './utils/feishu-bot';

async function globalTeardown(): Promise<void> {
  console.log('[GlobalTeardown] Finalizing heal system...');

  // Get cache stats
  const stats = healCache.stats();

  if (process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET && process.env.FEISHU_CHAT_ID) {
    const cacheInfo =
      stats.size > 0 ? `缓存中有 ${stats.size} 条记录` : '缓存为空';

    await sendFeishuMessage(
      '✅ AI 自愈测试完成',
      `测试运行已结束。${cacheInfo}`,
      'success'
    );
  }

  console.log(`[GlobalTeardown] Heal cache stats: ${stats.size} entries`);
  console.log('[GlobalTeardown] Heal system finalized');
}

export default globalTeardown;
