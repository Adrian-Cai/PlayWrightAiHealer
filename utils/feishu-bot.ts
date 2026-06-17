/**
 * Feishu Bot — Sends heal notifications to Feishu group chat
 * Subscribes to HealEventBus and dispatches formatted messages
 */

import axios from 'axios';
import * as dotenv from 'dotenv';
import { HealEvent } from '../skills/self-healing-locator/contract';
import { healEventBus } from './heal-event-bus';

dotenv.config();

const APP_ID = process.env.FEISHU_APP_ID || '';
const APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const CHAT_ID = process.env.FEISHU_CHAT_ID || '';

let tenantAccessToken: string = '';
let tokenExpiry: number = 0;

/**
 * Get tenant access token from Feishu API
 * Caches the token and expires 300s before actual expiry
 */
async function getTenantAccessToken(): Promise<string> {
  if (tenantAccessToken && Date.now() < tokenExpiry) {
    return tenantAccessToken;
  }

  if (!APP_ID || !APP_SECRET) {
    throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET must be configured');
  }

  const resp = await axios.post(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    { app_id: APP_ID, app_secret: APP_SECRET }
  );

  if (resp.data.code !== 0) {
    throw new Error(`Failed to get tenant_access_token: ${resp.data.msg}`);
  }

  tenantAccessToken = resp.data.tenant_access_token;
  tokenExpiry = Date.now() + (resp.data.expire - 300) * 1000;
  return tenantAccessToken;
}

/**
 * Send a heal event notification to Feishu
 */
async function sendHealNotification(event: HealEvent): Promise<void> {
  if (!APP_ID || !APP_SECRET || !CHAT_ID) {
    console.log(`[Feishu] Skipping notification (not configured): ${event.type}`);
    return;
  }

  const status = getStatusForEvent(event.type);
  const emoji = getEmojiForStatus(status);

  const lines: Array<{ tag: string; text: string }> = [];

  lines.push({ tag: 'text', text: `${emoji} **${event.type}**` });
  lines.push({ tag: 'text', text: `📋 元素: ${event.input.description}` });
  lines.push({ tag: 'text', text: `🎯 动作: ${event.input.action}` });
  lines.push({ tag: 'text', text: `🔍 原始定位器: \`${event.input.originalLocator}\`` });

  if (event.output) {
    lines.push({
      tag: 'text',
      text: `🔧 AI 修复定位器: \`${event.output.locator}\``,
    });
    lines.push({
      tag: 'text',
      text: `💯 置信度: ${(event.output.confidence * 100).toFixed(0)}%`,
    });
    lines.push({ tag: 'text', text: `💬 原因: ${event.output.reason}` });
  }

  if (event.validation) {
    if (!event.validation.valid) {
      lines.push({
        tag: 'text',
        text: `❌ 验证失败: ${event.validation.errors.join('; ')}`,
      });
    }
  }

  if (event.error) {
    lines.push({ tag: 'text', text: `❗ 错误: ${event.error.substring(0, 200)}` });
  }

  lines.push({ tag: 'text', text: `🌐 页面: ${event.input.pageUrl}` });
  lines.push({ tag: 'text', text: `⏱️ 耗时: ${event.durationMs}ms` });

  if (event.testName) {
    lines.push({ tag: 'text', text: `📝 测试: ${event.testName}` });
  }

  if (event.jenkinsUrl) {
    lines.push({ tag: 'text', text: `🔗 Jenkins: ${event.jenkinsUrl}` });
  }

  lines.push({ tag: 'text', text: `⏰ 时间: ${event.timestamp}` });

  const token = await getTenantAccessToken();
  const content: Array<Array<{ tag: string; text: string }>> = lines.map((line) => [line]);

  const payload = {
    receive_id: CHAT_ID,
    msg_type: 'post',
    content: JSON.stringify({
      zh_cn: {
        title: `${emoji} ${event.type}`,
        content,
      },
    }),
  };

  try {
    await axios.post(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log(`[Feishu] Notification sent: ${event.type}`);
  } catch (error: any) {
    console.error(`[Feishu] Error sending notification: ${error.message}`);
    if (error.response?.data) {
      console.error(`[Feishu] Response: ${JSON.stringify(error.response.data)}`);
    }
  }
}

/**
 * Get status for event type
 */
function getStatusForEvent(type: string): 'success' | 'warning' | 'error' | 'info' {
  if (type === 'HEAL_SUCCESS' || type === 'VALIDATION_PASSED' || type === 'CACHE_HIT') {
    return 'success';
  }
  if (type === 'HEAL_FAILED' || type === 'VALIDATION_FAILED') {
    return 'error';
  }
  return 'info';
}

/**
 * Get emoji for status
 */
function getEmojiForStatus(status: 'success' | 'warning' | 'error' | 'info'): string {
  const map = {
    success: '✅',
    warning: '⚠️',
    error: '❌',
    info: 'ℹ️',
  };
  return map[status];
}

/**
 * Initialize Feishu bot subscriptions
 * Call this once during test setup (e.g., globalSetup)
 */
export function initFeishuBot(): void {
  if (!APP_ID || !APP_SECRET || !CHAT_ID) {
    console.log('[Feishu] Feishu bot is disabled (missing configuration)');
    return;
  }

  console.log('[Feishu] Initializing Feishu bot subscriptions...');

  // Subscribe to all heal events
  healEventBus.on('all', async (event) => {
    // Only send notifications for interesting events
    const notifiableEvents = [
      'HEAL_SUCCESS',
      'HEAL_FAILED',
      'VALIDATION_FAILED',
      'CACHE_HIT',
    ];

    if (notifiableEvents.includes(event.type)) {
      await sendHealNotification(event);
    }
  });

  console.log('[Feishu] Feishu bot subscriptions initialized');
}

export interface HealEventSummary {
  type: string;
  input: {
    originalLocator: string;
    description: string;
    action: string;
    pageUrl: string;
  };
  output?: {
    locator: string;
    confidence: number;
    reason: string;
  };
  error?: string;
  durationMs?: number;
  timestamp?: string;
  testName?: string;
}

export interface FailedCaseSummary {
  title: string;
  file: string;
  status: string;
  error?: string;
}

export interface CaseSummaryOptions {
  title: string;
  status: 'success' | 'error' | 'warning';
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  healTriggeredCount: number;
  healSuccessCount: number;
  healFailedCount: number;
  failedCases: FailedCaseSummary[];
  healEvents: HealEventSummary[];
  reportUrl?: string;
}

/**
 * Send a single end-of-run summary card to Feishu.
 * Called by FeishuReporter.onEnd() in reporters/feishu-reporter.ts
 */
export async function sendCaseSummaryNotification(opts: CaseSummaryOptions): Promise<void> {
  if (!APP_ID || !APP_SECRET || !CHAT_ID) {
    console.log(`[Feishu] Skipping summary notification (not configured): ${opts.title}`);
    return;
  }

  const statusEmoji = {
    success: '✅',
    error: '❌',
    warning: '⚠️',
  } as const;

  const lines: Array<Array<{ tag: string; text: string }>> = [];

  lines.push([{ tag: 'text', text: `📊 测试总数：${opts.total}` }]);
  lines.push([{ tag: 'text', text: `✅ 通过：${opts.passed}` }]);
  lines.push([{ tag: 'text', text: `❌ 失败：${opts.failed}` }]);
  lines.push([{ tag: 'text', text: `⏭️ 跳过：${opts.skipped}` }]);
  lines.push([{ tag: 'text', text: `🔧 自愈触发：${opts.healTriggeredCount}` }]);
  lines.push([{ tag: 'text', text: `✅ 自愈成功：${opts.healSuccessCount}` }]);
  lines.push([{ tag: 'text', text: `❌ 自愈失败：${opts.healFailedCount}` }]);

  if (opts.reportUrl) {
    lines.push([{ tag: 'text', text: `📄 测试报告：${opts.reportUrl}` }]);
  }

  if (opts.failedCases.length > 0) {
    lines.push([{ tag: 'text', text: `\n失败用例明细：` }]);
    opts.failedCases.slice(0, 10).forEach((item, index) => {
      const error = item.error ? item.error.split('\n')[0].substring(0, 120) : '-';
      lines.push([
        {
          tag: 'text',
          text:
            `\n${index + 1}. ${item.title}\n` +
            `文件：${item.file}\n` +
            `状态：${item.status}\n` +
            `错误：${error}`,
        },
      ]);
    });
  }

  if (opts.healEvents.length > 0) {
    const notable = opts.healEvents.filter(
      (e) => e.type === 'HEAL_SUCCESS' || e.type === 'HEAL_FAILED'
    );
    if (notable.length > 0) {
      lines.push([{ tag: 'text', text: `\nAI 自愈明细：` }]);
      notable.slice(0, 10).forEach((item, index) => {
        lines.push([
          {
            tag: 'text',
            text:
              `\n${index + 1}. [${item.type}] ${item.input.description}\n` +
              `原始定位器：${item.input.originalLocator}\n` +
              `AI 定位器：${item.output?.locator || '-'}\n` +
              `动作：${item.input.action}`,
          },
        ]);
      });
    }
  }

  const token = await getTenantAccessToken();

  const payload = {
    receive_id: CHAT_ID,
    msg_type: 'post',
    content: JSON.stringify({
      zh_cn: {
        title: `${statusEmoji[opts.status]} ${opts.title}`,
        content: lines,
      },
    }),
  };

  try {
    await axios.post(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log(`[Feishu] Summary notification sent: ${opts.title}`);
  } catch (error: any) {
    console.error(`[Feishu] Error sending summary notification: ${error.message}`);
    if (error.response?.data) {
      console.error(`[Feishu] Response: ${JSON.stringify(error.response.data)}`);
    }
  }
}

/**
 * Send a generic Feishu message (for backward compatibility)
 */
export async function sendFeishuMessage(
  title: string,
  content: string,
  status: 'info' | 'success' | 'warning' | 'error' = 'info'
): Promise<void> {
  if (!APP_ID || !APP_SECRET || !CHAT_ID) {
    console.log(`[Feishu] Skipping message (not configured): ${title}`);
    return;
  }

  const emoji = getEmojiForStatus(status);
  const lines: Array<{ tag: string; text: string }> = [
    { tag: 'text', text: `${emoji} **${title}**` },
    { tag: 'text', text: content },
  ];

  const token = await getTenantAccessToken();
  const msgContent: Array<Array<{ tag: string; text: string }>> = lines.map((line) => [line]);

  const payload = {
    receive_id: CHAT_ID,
    msg_type: 'post',
    content: JSON.stringify({
      zh_cn: {
        title: `${emoji} ${title}`,
        content: msgContent,
      },
    }),
  };

  try {
    await axios.post(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log(`[Feishu] Message sent: ${title}`);
  } catch (error: any) {
    console.error(`[Feishu] Error sending message: ${error.message}`);
  }
}
