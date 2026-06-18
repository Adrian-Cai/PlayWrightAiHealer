/**
 * Feishu Bot — Sends heal notifications to Feishu group chat
 * Subscribes to HealEventBus and dispatches interactive card messages
 */

import axios from 'axios';
import * as dotenv from 'dotenv';
import { HealEvent, HealInput, HealOutput } from '../skills/self-healing-locator/contract';
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

/** 转义 lark_md 中的特殊字符，防止不可信内容破坏卡片结构 */
function escapeMd(str: string): string {
  return (str ?? '').replace(/([\\`*_[\](){}!#<>])/g, '\\$1');
}

/** 仅转义会影响文本节点的字符，保留 label 自身的加粗语义 */
function escapeMdInline(str: string): string {
  return (str ?? '').replace(/([\\`*_[\]()<>])/g, '\\$1');
}

/** A short key-value field rendered in a 2-column layout. */
function field(label: string, value: string) {
  return {
    is_short: true,
    text: { tag: 'lark_md', content: `**${escapeMdInline(label)}**\n${escapeMd(value)}` },
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
  // note 元素用 elements 数组（不是 text 字段），每项是 plain_text/lark_md
  return { tag: 'note', elements: [{ tag: 'lark_md', content }] };
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

/**
 * Truncate a string to a max length, appending an ellipsis.
 * @param multiline  默认 false：仅取首行（适合标题/用例名等不应含换行的字段）；
 *                   true 时保留换行，适合在 ``` 代码块中展示多行错误堆栈。
 */
function truncate(str: string, max = 200, multiline = false): string {
  if (!str) return '-';
  const text = multiline ? str : str.split('\n')[0];
  return text.length > max ? text.substring(0, max) + '…' : text;
}

/** Wrap a locator/value in inline code for readability. */
function code(value: string): string {
  // 代码段内的反引号用双反引号包裹 + 空格隔离，避免内容含 ` 时提前闭合
  const v = value || '-';
  return v.includes('`') ? `\`\` ${v} \`\`` : `\`${v}\``;
}

/**
 * Send a Feishu interactive card to the configured chat.
 * @param options.rethrow  失败时是否向上抛出（关键的一次性卡片建议开启，由 reporter 决定如何处理）
 * @param options.retries  失败重试次数（指数退避），缓解网络抖动导致的静默丢失
 */
async function sendCard(
  title: string,
  status: Status,
  elements: any[],
  options: { rethrow?: boolean; retries?: number } = {}
): Promise<void> {
  const { rethrow = false, retries = 0 } = options;

  // update_multi: true is REQUIRED for the card to be patchable later
  // (Feishu rejects PATCH /im/v1/messages/:id without it). The callback
  // server relies on this to update the card after approve/reject.
  const card = {
    config: { wide_screen_mode: true, enable_forward: true, update_multi: true },
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

  const isRetryable = (error: any): boolean => {
    // 无 response = 网络层错误/超时；5xx 与 429 为服务端瞬时问题，值得重试
    if (!error.response) return true;
    const code = error.response.status;
    return code >= 500 || code === 429;
  };

  let lastError: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // 每次循环重新取 token：命中缓存几乎零成本；401 失效后能自动重新获取
      const token = await getTenantAccessToken();
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
      return;
    } catch (error: any) {
      lastError = error;
      console.error(
        `[Feishu] Error sending card (attempt ${attempt + 1}/${retries + 1}): ${error.message}`
      );
      if (error.response?.data) {
        console.error(`[Feishu] Response: ${JSON.stringify(error.response.data)}`);
      }
      // 401：token 可能已被服务端失效，清空缓存以便下次重新获取，否则后续重试必败
      if (error.response?.status === 401) {
        tenantAccessToken = '';
        tokenExpiry = 0;
      }
      // 4xx（非 429）多为 payload/权限问题，重试无意义，直接跳出
      if (!(attempt < retries && isRetryable(error))) break;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }

  if (rethrow && lastError) throw lastError;
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

  const token = resp.data.tenant_access_token;
  const expire = Number(resp.data.expire);
  if (!token || !Number.isFinite(expire) || expire <= 0) {
    throw new Error(
      `Invalid tenant_access_token response: ${JSON.stringify(resp.data)}`
    );
  }

  tenantAccessToken = token;
  // 提前 300s 过期；expire 本身不足 300s 时至少保留一半时长，避免负数导致缓存立即失效
  const safetyLead = Math.min(300, Math.max(60, expire / 2));
  tokenExpiry = Date.now() + (expire - safetyLead) * 1000;
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
  elements.push(divMd(`**📋 元素描述**\n${escapeMd(event.input.description)}`));
  elements.push({
    tag: 'div',
    fields: [
      field('🎯 动作', event.input.action),
      field('⏱️ 耗时', Number.isFinite(event.durationMs) ? `${event.durationMs}ms` : '-'),
    ],
  });

  elements.push(hr());

  // --- Locators ---
  elements.push({
    tag: 'div',
    fields: [field('🔍 原始定位器', code(event.input.originalLocator))],
  });

  if (event.output) {
    const conf = Number(event.output.confidence);
    const confText =
      Number.isFinite(conf) && conf >= 0 && conf <= 1
        ? `${(conf * 100).toFixed(0)}%`
        : '-';
    elements.push({
      tag: 'div',
      fields: [
        field('🔧 AI 修复定位器', code(event.output.locator)),
        field('💯 置信度', confText),
      ],
    });
    elements.push(divMd(`**💬 修复原因**\n${escapeMd(event.output.reason ?? '-')}`));
  }

  if (event.cacheHit) {
    elements.push(noteMd('⚡ 本次结果来自自愈缓存命中（未调用 AI）'));
  }

  // --- Validation / errors ---
  if (event.validation && !event.validation.valid) {
    elements.push(divMd(`**❌ 验证失败**\n${escapeMd(event.validation.errors.join('；'))}`));
  }

  if (event.error) {
    // 错误堆栈通常多行且关键信息不在首行，保留换行以便在代码块中完整呈现
    elements.push(divMd(`**❗ 错误详情**\n\`\`\`\n${truncate(event.error, 500, true)}\n\`\`\``));
  }

  elements.push(hr());

  // --- Context (page / test / time) ---
  elements.push(divMd(`**🌐 页面地址**\n${escapeMd(event.input.pageUrl || '-')}`));

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

/** 仅这些事件类型会触发飞书通知 */
const NOTIFIABLE_EVENTS: ReadonlyArray<string> = [
  'HEAL_SUCCESS',
  'HEAL_FAILED',
  'VALIDATION_FAILED',
  'CACHE_HIT',
];

let feishuBotInitialized = false;

/** 事件总线回调（命名函数，便于 off 反订阅与测试） */
async function handleHealEvent(event: HealEvent): Promise<void> {
  if (NOTIFIABLE_EVENTS.includes(event.type)) {
    await sendHealNotification(event);
  }
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

  if (feishuBotInitialized) {
    console.log('[Feishu] Feishu bot already initialized, skip');
    return;
  }

  console.log('[Feishu] Initializing Feishu bot subscriptions...');

  // Subscribe to all heal events
  healEventBus.on('all', handleHealEvent);

  feishuBotInitialized = true;
  console.log('[Feishu] Feishu bot subscriptions initialized');
}

export interface HealEventSummary {
  type: HealEvent['type'];
  input: Pick<HealInput, 'originalLocator' | 'description' | 'action' | 'pageUrl'>;
  output?: Pick<HealOutput, 'locator' | 'confidence' | 'reason'>;
  error?: HealEvent['error'];
  durationMs?: HealEvent['durationMs'];
  timestamp?: HealEvent['timestamp'];
  testName?: HealEvent['testName'];
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
  reportArchiveUrl?: string;
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
      field('测试总数', String(opts.total)),
      field('通过', String(opts.passed)),
      field('失败', String(opts.failed)),
      field('跳过', String(opts.skipped)),
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
        `${index + 1}. **${escapeMdInline(truncate(item.title, 80))}**\n` +
          `📁 ${escapeMd(item.file)}\n` +
          `🏷️ ${escapeMd(item.status)}\n` +
          `💬 ${escapeMd(truncate(item.error || '-', 120))}`
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
          `${index + 1}. ${icon} ${escapeMd(item.input.description)}\n` +
            `🔍 ${code(item.input.originalLocator)} → ${code(item.output?.locator || '-')}\n` +
            `🎯 ${escapeMd(item.input.action)}`
        );
      });
      elements.push(divMd(healBlocks.join('\n\n')));
    }
  }

  // --- Action button ---
  if (opts.reportUrl) {
    elements.push(hr());
    const actions: any[] = [linkButton('📄 查看完整测试报告', opts.reportUrl, 'primary')];
    // 浏览器内 HTML 报告受 Jenkins CSP 限制可能白屏，提供压缩包下载兜底（解压后本地打开 index.html）
    if (opts.reportArchiveUrl) {
      actions.push(linkButton('⬇️ 下载报告压缩包', opts.reportArchiveUrl, 'default'));
    }
    elements.push({ tag: 'action', actions });
  }

  await sendCard(opts.title, opts.status, elements, { retries: 2 });
}

/**
 * Send a "pending review" interactive card listing AI heal proposals.
 *
 * Phase 2: card is display-only (no buttons). Phase 3 will add
 * [确认替换] / [拒绝] buttons per proposal whose value carries the proposalId
 * for the callback server to consume.
 *
 * Only pending proposals (AI healed successfully, awaiting human review) are
 * shown with full detail. Failed proposals (AI couldn't heal) are listed
 * compactly for awareness.
 */
export interface ReviewCardProposal {
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'failed';
  testName?: string;
  testFile?: string;
  pageUrl?: string;
  locatorKey: string;
  elementName: string;
  action: string;
  oldLocator: string;
  newLocator?: string;
  confidence?: number;
  reason?: string;
  errorDetail?: string;
}

export interface ReviewCardOptions {
  title: string;
  status: 'success' | 'error' | 'warning';
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  proposals: ReviewCardProposal[];
  reportUrl?: string;
  reportArchiveUrl?: string;
}

export async function sendReviewCard(opts: ReviewCardOptions): Promise<void> {
  if (!APP_ID || !APP_SECRET || !CHAT_ID) {
    console.log(`[Feishu] Skipping review card (not configured): ${opts.title}`);
    return;
  }

  const pending = opts.proposals.filter((p) => p.status === 'pending' && p.newLocator);
  const failed = opts.proposals.filter((p) => p.status === 'failed');

  const elements: any[] = [];

  // --- Overview ---
  elements.push({
    tag: 'div',
    fields: [
      field('测试总数', String(opts.total)),
      field('通过', String(opts.passed)),
      field('失败', String(opts.failed)),
      field('跳过', String(opts.skipped)),
    ],
  });
  elements.push(hr());
  elements.push({
    tag: 'div',
    fields: [
      field('⏳ 待审核', String(pending.length)),
      field('❌ 自愈失败', String(failed.length)),
    ],
  });

  // --- Pending proposals (full detail) ---
  if (pending.length > 0) {
    elements.push(hr());
    elements.push(divMd(`**🤖 待审核修复项（共 ${pending.length} 个）**`));
    const callbackToken = process.env.HEALER_CALLBACK_TOKEN || '';
    pending.slice(0, 10).forEach((item, index) => {
      const conf =
        typeof item.confidence === 'number' && item.confidence >= 0 && item.confidence <= 1
          ? `${(item.confidence * 100).toFixed(0)}%`
          : '-';
      elements.push(
        divMd(
          `${index + 1}. **${escapeMdInline(item.elementName)}**\n` +
            `📝 ${escapeMd(truncate(item.testName || '-', 60))}\n` +
            `🔑 \`${escapeMd(item.locatorKey)}\`  🎯 ${escapeMd(item.action)}\n` +
            `❌ ${code(item.oldLocator)}\n` +
            `✅ ${code(item.newLocator || '-')}\n` +
            `💯 ${conf}  💬 ${escapeMd(truncate(item.reason || '-', 120))}`
        )
      );
      // Phase 3: approve/reject buttons. value carries proposalId + token.
      // The callback server (scripts/feishu-callback-server.js) reads
      // evt.action.value to identify the action and authorize it.
      // token is an optional shared secret as a defense-in-depth layer on top
      // of the SDK's built-in signature verification.
      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✅ 确认替换' },
            type: 'primary',
            value: { action: 'approve_locator', proposalId: item.id, token: callbackToken },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '❌ 拒绝' },
            type: 'danger',
            value: { action: 'reject_locator', proposalId: item.id, token: callbackToken },
          },
        ],
      });
    });
    if (pending.length > 10) {
      elements.push(noteMd(`…还有 ${pending.length - 10} 个待审核项未展示`));
    }
  }

  // --- Failed proposals (compact) ---
  if (failed.length > 0) {
    elements.push(hr());
    elements.push(divMd(`**⚠️ 自愈失败项（共 ${failed.length} 个）**`));
    const blocks: string[] = failed.slice(0, 5).map((item, index) =>
      `${index + 1}. ${escapeMdInline(item.elementName)}  🔑 \`${escapeMd(item.locatorKey)}\`\n` +
      `❌ ${code(item.oldLocator)}\n` +
      `💬 ${escapeMd(truncate(item.errorDetail || '-', 120))}`
    );
    elements.push(divMd(blocks.join('\n\n')));
  }

  // --- Report links ---
  if (opts.reportUrl || opts.reportArchiveUrl) {
    elements.push(hr());
    const actions: any[] = [];
    if (opts.reportUrl) actions.push(linkButton('📄 查看测试报告', opts.reportUrl, 'primary'));
    if (opts.reportArchiveUrl) actions.push(linkButton('⬇️ 下载报告压缩包', opts.reportArchiveUrl, 'default'));
    elements.push({ tag: 'action', actions });
  }

  await sendCard(opts.title, opts.status, elements, { retries: 2 });
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
