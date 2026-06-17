#!/usr/bin/env node
/**
 * Feishu Callback Server (long-connection mode)
 *
 * Receives card-action callbacks (button clicks on the review card) via the
 * Feishu WebSocket long-connection. No public URL / no HTTP server needed —
 * the SDK maintains an outbound WS to Feishu and pushes callbacks to us.
 *
 * Prerequisites (Feishu app backend):
 *   - 事件与回调 → 事件配置 → 推送方式 = "使用长连接接收事件"
 *   - 事件与回调 → 卡片交互回调 → 同样长连接模式
 *   - App has im:message + card permissions
 *
 * Env vars (already used by the test runner):
 *   FEISHU_APP_ID        (required) — app id
 *   FEISHU_APP_SECRET    (required) — app secret
 *   HEALER_CALLBACK_TOKEN (optional) — shared secret checked against button value.token
 *   FEISHU_DOMAIN         (optional) — 'feishu' (default) | 'lark' for international
 *
 * Run:  npm run feishu:callback
 * Stop: Ctrl-C (SDK auto-reconnects; process must stay alive)
 */

const lark = require('@larksuiteoapi/node-sdk');
require('dotenv').config();

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;

if (!APP_ID || !APP_SECRET) {
  console.error('[FeishuCallback] FEISHU_APP_ID / FEISHU_APP_SECRET not configured. Exiting.');
  process.exit(1);
}

const domain =
  process.env.FEISHU_DOMAIN === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu;

// Client is used to update the card after approve/reject (remove buttons,
// show the outcome so the reviewer sees confirmation in-place).
const client = new lark.Client({
  appId: APP_ID,
  appSecret: APP_SECRET,
  domain,
});

const {
  parseCallbackValue,
  handleReviewCallback,
} = require('../utils/healer-review-actions');

/**
 * Build an updated card body that replaces the action buttons with a result
 * note, so the reviewer sees immediate in-place feedback.
 */
function buildUpdatedCard(outcome, originalProposal) {
  const statusLine = outcome.ok
    ? outcome.message
    : `⚠️ 操作失败：${outcome.error}`;

  const elements = [
    {
      tag: 'div',
      fields: [
        { is_short: true, text: { tag: 'lark_md', content: `**Locator Key**\n\`${originalProposal?.locatorKey || '-'}\`` } },
        { is_short: true, text: { tag: 'lark_md', content: `**元素**\n${originalProposal?.elementName || '-'}` } },
      ],
    },
    { tag: 'hr' },
    {
      tag: 'div',
      text: { tag: 'lark_md', content: statusLine },
    },
  ];

  return {
    config: { wide_screen_mode: true },
    header: {
      template: outcome.ok ? 'green' : 'red',
      title: { tag: 'plain_text', content: outcome.ok ? '✅ 已处理' : '⚠️ 处理失败' },
    },
    elements,
  };
}

/**
 * Find the original proposal (for card update display). Best-effort: if not
 * found, fall back to a minimal stub.
 */
function findProposal(proposalId) {
  try {
    const { readProposals } = require('../utils/healer-proposal-store');
    return readProposals().find((p) => p.id === proposalId) || null;
  } catch {
    return null;
  }
}

// --- Long-connection setup ---

const dispatcher = new lark.EventDispatcher({}).register({
  cardAction: async (event) => {
    // event shape: { messageId, chatId, operator, action: { value, tag, ... } }
    const rawValue = event?.action?.value;
    const value = parseCallbackValue(rawValue);

    if (!value) {
      console.warn('[FeishuCallback] Ignored card action with unrecognized value:', JSON.stringify(rawValue));
      return {};
    }

    const operator = event?.operator?.openId || 'unknown';
    console.log(
      `[FeishuCallback] Received ${value.action} for proposal ${value.proposalId} from ${operator}`
    );

    const originalProposal = findProposal(value.proposalId);
    const outcome = handleReviewCallback(value);

    if (outcome.ok) {
      console.log(`[FeishuCallback] ✓ ${outcome.message}`);
    } else {
      console.warn(`[FeishuCallback] ✗ ${outcome.error}`);
    }

    // Update the original card in-place so the reviewer sees the outcome
    // and the buttons disappear (prevents double-clicks).
    if (event?.messageId) {
      try {
        const card = buildUpdatedCard(outcome, originalProposal);
        await client.im.message.patch({
          path: { message_id: event.messageId },
          data: { content: JSON.stringify(card) },
        });
        console.log(`[FeishuCallback] Card updated: ${event.messageId}`);
      } catch (err) {
        // Non-fatal: the locator/proposal state is already persisted; card
        // update is cosmetic. Log and move on.
        console.error('[FeishuCallback] Failed to update card:', err?.message || err);
      }
    }

    // Returning {} tells the SDK not to auto-respond; we patched the card ourselves.
    return {};
  },
});

const wsClient = new lark.WSClient({
  appId: APP_ID,
  appSecret: APP_SECRET,
  domain,
  loggerLevel: lark.LoggerLevel.info,
});

(async () => {
  console.log('[FeishuCallback] Starting long-connection to Feishu...');
  console.log(`[FeishuCallback] Domain: ${process.env.FEISHU_DOMAIN || 'feishu (default)'}`);
  console.log(
    `[FeishuCallback] Token guard: ${process.env.HEALER_CALLBACK_TOKEN ? 'enabled' : 'disabled (relying on SDK signature only)'}`
  );
  await wsClient.start({ eventDispatcher: dispatcher });
  console.log('[FeishuCallback] Long-connection established. Waiting for card actions...');
})().catch((err) => {
  console.error('[FeishuCallback] Failed to start:', err);
  process.exit(1);
});
