/**
 * Feishu Bot — Sends heal notifications to Feishu group chat
 * Subscribes to HealEventBus and dispatches interactive card messages
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

type Status = 'success' | 'warning' | 'error' | 'info';

// ---------------------------------------------------------------------------
// Feishu interactive card helpers
// ---------------------------------------------------------------------------

/** Map status to Feishu card header template color. */
function statusToTemplate(status: Status): string {
  const map: Record<Status, string> = {
    success: 'green',
    warning: 'orange',
    error: 'red',
    info: 'blue',
  };
  return map[status];
}

function statusToEmoji(status: Status): string {
  const map: Record<Status, string> = {
    success: '✅',
    warning: '⚠️',
    error: '❌',
    info: 'ℹ️',
  };
  return map[status];
}

/** A short key-value field rendered in a 2-column layout. */
function field(label: string, value: string) {
  return {
    is_short: true,
    text: { tag: 'lark_md', content: `**${label}**\n${value}` },
  };
}

/** A full-width lark_md text block. */
function divMd(content: string) {
  return { tag: 'div', text: { tag: 'lark_md', content } };
}

/** Horizontal divider. */
function hr() {
  return { tag: 'hr' };
}

/** Small grey note line (good for timestamps / secondary info). */
function noteMd(content: string) {
  return { tag: 'note', text: { tag: 'lark_md', content } };
}

/** A clickable button that opens a URL. */
function linkButton(text: string, url: string, type: 'primary' | 'default' = 'primary') {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    url,
    type,
  };
}

/** Truncate a long string to a max length, appending an ellipsis. */
function truncate(str: string, max = 200): string {
  if (!str) return '-';
  const oneLine = str.split('\n')[0];
  return oneLine.length > max ? oneLine.substring(0, max) + '…' : oneLine;
}

/** Wrap a locator/value in inline code for readability. */
function code(value: string): string {
  return `\`${value || '-'}\``;
}

/**
 * Send a Feishu interactive card to the configured chat.
 */
async function sendCard(title: string, status: Status, elements: any[]): Promise<void> {
  const token = await getTenantAccessToken();

  const card = {
    config: { wide_screen_mode: true, enable_forward: true },
    header: {
      title: { tag: 'plain_text', content: `${statusToEmoji(status)} ${title}` },
      template: statusToTemplate(status),
    },
    elements,
  };

  const payload = {
    receive_id: CHAT_ID,
    msg_type: 'interactive',
    content: JSON.stringify(card),
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
    console.log(`[Feishu] Card sent: ${title}`);
  } catch (error: any) {
    console.error(`[Feishu] Error sending card: ${error.message}`);
    if (error.response?.data) {
      console.error(`[Feishu] Response: ${JSON.stringify(error.response.data)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

/**
 * Get tenant access token from Feishu API.
 * Caches the token and expires 300s before actual expiry.
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

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/**
 * Send a single heal event as an interactive card.
 */
async function sendHealNotification(event: HealEvent): Promise<void> {
  if (!APP_ID || !APP_SECRET || !CHAT_ID) {
    console.log(`[Feishu] Skipping notification (not configured): ${event.type}`);
    return;
  }

  const status = getStatusForEvent(event.type);
  const elements: any[] = [];

  // --- Element & action ---
  elements.push(divMd(`**📋 元素描述**\n${event.input.description}`));
  elements.push({
    tag: 'div',
    fields: [
      field('🎯 动作', event.input.action),
      field('⏱️ 耗时', `${event.durationMs}ms`),
    ],
  });

  elements.push(hr());

  // --- Locators ---
  elements.push({
    tag: 'div',
    fields: [field('🔍 原始定位器', code(event.input.originalLocator))],
  });

  if (event.output) {
    elements.push({
      tag: 'div',
      fields: [
        field('🔧 AI 修复定位器', code(event.output.locator)),
        field('💯 置信度', `${(event.output.confidence * 100).toFixed(0)}%`),
      ],
    });
    elements.push(divMd(`**💬 修复原因**\n${event.output.reason}`));
  }

  if (event.cacheHit) {
    elements.push(noteMd('⚡ 本次结果来自自愈缓存命中（未调用 AI）'));
  }

  // --- Validation / errors ---
  if (event.validation && !event.validation.valid) {
    elements.push(divMd(`**❌ 验证失败**\n${event.validation.errors.join('；')}`));
  }

  if (event.error) {
    elements.push(divMd(`**❗ 错误详情**\n\`\`\`\n${truncate(event.error, 500)}\n\`\`\``));
  }

  elements.push(hr());

  // --- Context (page / test / time) ---
  elements.push(divMd(`**🌐 页面地址**\n${event.input.pageUrl || '-'}`));

  const ctxFields: any[] = [];
  if (event.testName) ctxFields.push(field('📝 测试用例', truncate(event.testName, 60)));
  if (event.timestamp) ctxFields.push(field('⏰ 时间', event.timestamp.replace('T', ' ').split('.')[0]));
  if (ctxFields.length > 0) elements.push({ tag: 'div', fields: ctxFields });

  // --- Action buttons ---
  const actions: any[] = [];
  if (event.jenkinsUrl) actions.push(linkButton('🔗 查看 Jenkins', event.jenkinsUrl, 'primary'));
  if (actions.length > 0) elements.push({ tag: 'action', actions });

  await sendCard(event.type, status, elements);
}

/**
 * Get status for event type
 */
function getStatusForEvent(type: string): Status {
  if (type === 'HEAL_SUCCESS' || type === 'VALIDATION_PASSED' || type === 'CACHE_HIT') {
    return 'success';
  }
  if (type === 'HEAL_FAILED' || type === 'VALIDATION_FAILED') {
    return 'error';
  }
  return 'info';
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

  const elements: any[] = [];

  // --- Test result stats (2x2 grid) ---
  elements.push({
    tag: 'div',
    fields: [
      field('📊 测试总数', String(opts.total)),
      field('✅ 通过', String(opts.passed)),
      field('❌ 失败', String(opts.failed)),
      field('⏭️ 跳过', String(opts.skipped)),
    ],
  });

  elements.push(hr());

  // --- Self-healing stats ---
  elements.push({
    tag: 'div',
    fields: [
      field('🔧 自愈触发', String(opts.healTriggeredCount)),
      field('✅ 自愈成功', String(opts.healSuccessCount)),
      field('❌ 自愈失败', String(opts.healFailedCount)),
    ],
  });

  // --- Failed cases detail ---
  if (opts.failedCases.length > 0) {
    elements.push(hr());
    elements.push(divMd(`**🧨 失败用例明细（共 ${opts.failedCases.length} 个）**`));
    const failedBlocks: string[] = [];
    opts.failedCases.slice(0, 10).forEach((item, index) => {
      failedBlocks.push(
        `${index + 1}. **${truncate(item.title, 80)}**\n` +
          `📁 ${item.file}\n` +
          `🏷️ ${item.status}\n` +
          `💬 ${truncate(item.error || '-', 120)}`
      );
    });
    elements.push(divMd(failedBlocks.join('\n\n')));
    if (opts.failedCases.length > 10) {
      elements.push(noteMd(`…还有 ${opts.failedCases.length - 10} 个失败用例未展示，详见报告`));
    }
  }

  // --- AI self-heal detail ---
  if (opts.healEvents.length > 0) {
    const notable = opts.healEvents.filter(
      (e) => e.type === 'HEAL_SUCCESS' || e.type === 'HEAL_FAILED'
    );
    if (notable.length > 0) {
      elements.push(hr());
      elements.push(divMd(`**🤖 AI 自愈明细（共 ${notable.length} 条）**`));
      const healBlocks: string[] = [];
      notable.slice(0, 10).forEach((item, index) => {
        const icon = item.type === 'HEAL_SUCCESS' ? '✅' : '❌';
        healBlocks.push(
          `${index + 1}. ${icon} ${item.input.description}\n` +
            `🔍 ${code(item.input.originalLocator)} → ${code(item.output?.locator || '-')}\n` +
            `🎯 ${item.input.action}`
        );
      });
      elements.push(divMd(healBlocks.join('\n\n')));
    }
  }

  // --- Action button ---
  if (opts.reportUrl) {
    elements.push(hr());
    elements.push({ tag: 'action', actions: [linkButton('📄 查看完整测试报告', opts.reportUrl, 'primary')] });
  }

  await sendCard(opts.title, opts.status, elements);
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

  await sendCard(title, status, [divMd(content)]);
}
