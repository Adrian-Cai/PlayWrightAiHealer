/**
 * Playwright Global Setup — initializes heal system before tests
 * Sends START notification, initializes Feishu bot subscriptions
 */

import { HealEvent } from './skills/self-healing-locator/contract';
import { healEventBus } from './utils/heal-event-bus';
import { initFeishuBot, sendFeishuMessage } from './utils/feishu-bot';

async function globalSetup(): Promise<void> {
  console.log('[GlobalSetup] Initializing heal system...');

  // Initialize Feishu bot subscriptions
  initFeishuBot();

  // Emit START event
  const startEvent: HealEvent = {
    id: `start-${Date.now()}`,
    type: 'HEAL_START',
    timestamp: new Date().toISOString(),
    input: {
      originalLocator: 'N/A',
      description: 'Test run initialization',
      pageUrl: 'N/A',
      action: 'locate',
    },
    retryCount: 0,
    durationMs: 0,
    cacheHit: false,
  };

  if (process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET && process.env.FEISHU_CHAT_ID) {
    await sendFeishuMessage(
      '🚀 AI 自愈测试开始',
      '测试运行已启动，自动定位器修复系统已初始化。',
      'success'
    );
  }

  console.log('[GlobalSetup] Heal system initialized');
}

export default globalSetup;
