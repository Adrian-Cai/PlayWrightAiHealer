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
const { createHealPR } = require('../utils/cnb-pr-creator');

/**
 * Build an updated card body that replaces the action buttons with a result
 * note, so the reviewer sees immediate in-place feedback.
 *
 * NOTE on update_multi: the patch API request body has a top-level
 * `update_multi` field (true = update all messages sent with the same
 * content; false = update only this one message). We pass false here because
 * we only want to update the single clicked card. The config.update_multi
 * inside the card JSON is a DIFFERENT thing (it's a prerequisite flag that
 * must be true on the ORIGINAL card for patch to work at all — set in
 * feishu-bot.ts sendCard). These two are unrelated despite the same name.
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
    {
      // note 元素用 elements 数组（不是 text），每项是 plain_text/lark_md
      tag: 'note',
      elements: [
        { tag: 'plain_text', content: `🕐 处理时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}` },
      ],
    },
  ];

  return {
    config: { wide_screen_mode: true, update_multi: true },
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

// --- Helpers ---

/**
 * Race a promise against a timeout so a hung SDK call can't block the
 * callback response indefinitely. Resolves to the original value or rejects
 * with a timeout error.
 */
function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// --- Long-connection setup ---

const dispatcher = new lark.EventDispatcher({}).register({
  'card.action.trigger': async (event) => {
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

    // Debug: token match diagnostics (only first/last 4 chars to avoid leaking)
    const envTok = process.env.HEALER_CALLBACK_TOKEN || '';
    const recvTok = value.token || '';
    const tokMatch = envTok === recvTok;
    console.log(
      `[FeishuCallback] token check: env=${envTok ? envTok.slice(0,4)+'...'+envTok.slice(-4) : '(unset)'} ` +
      `recv=${recvTok ? recvTok.slice(0,4)+'...'+recvTok.slice(-4) : '(none)'} match=${tokMatch}`
    );

    const originalProposal = findProposal(value.proposalId);
    console.log(`[FeishuCallback] proposal lookup: ${originalProposal ? 'found (status=' + originalProposal.status + ')' : 'NOT FOUND'}`);

    const outcome = handleReviewCallback(value);

    if (outcome.ok) {
      console.log(`[FeishuCallback] ✓ ${outcome.message}`);
    } else {
      console.warn(`[FeishuCallback] ✗ ${outcome.error}`);
    }

    const messageId =
      event?.messageId || event?.message_id || event?.open_message_id ||
      event?.context?.open_message_id;
    console.log(`[FeishuCallback] messageId: ${messageId || '(missing)'}`);

    // ── Phase 4: create PR on approve ──
    // After approveLocatorProposal updates locator-store.json on disk, create
    // a git branch + commit + push + CNB PR so the change goes through code
    // review. The PR URL is included in the reply message.
    let prUrl = '';
    const autoPrEnabled = process.env.HEALER_AUTO_PR === 'true';
    if (outcome.ok && outcome.action === 'approve_locator' && originalProposal) {
      if (autoPrEnabled) {
        console.log('[FeishuCallback] HEALER_AUTO_PR=true, creating PR for approved locator...');
        const prResult = await createHealPR(originalProposal);
        if (prResult.ok) {
          prUrl = prResult.prUrl || '';
          console.log(`[FeishuCallback] PR created: ${prUrl} (branch: ${prResult.branch})`);
        } else {
          console.error(`[FeishuCallback] PR creation failed: ${prResult.error}`);
        }
      } else {
        console.log('[FeishuCallback] HEALER_AUTO_PR is not true; PR creation skipped.');
      }
    }

    // ── Send a reply message for reliable visual feedback ──
    // The PATCH API returns success but the Feishu client often doesn't
    // re-render the card (known behavior). A reply message is a new message,
    // guaranteed to appear in the chat, giving the reviewer immediate
    // confirmation that their click was processed.
    if (messageId && outcome.ok) {
      try {
        let replyText;
        if (outcome.action === 'approve_locator') {
          replyText = `✅ 已确认替换定位器 [${outcome.proposal.locatorKey}]\n${outcome.proposal.oldLocator} → ${outcome.proposal.newLocator}`;
          if (prUrl) {
            replyText += `\n\n🔗 PR: ${prUrl}`;
          } else if (autoPrEnabled) {
            replyText += `\n\n⚠️ PR 创建失败，请手动提交 locator-store.json`;
          } else {
            replyText += `\n\nℹ️ 自动提 PR 未启用（设置 HEALER_AUTO_PR=true 可开启）`;
          }
        } else {
          replyText = `❌ 已拒绝修复建议 [${outcome.proposal.locatorKey}]`;
        }
        const resp = await withTimeout(
          client.im.message.reply({
            path: { message_id: messageId },
            data: {
              msg_type: 'text',
              content: JSON.stringify({ text: replyText }),
            },
          }),
          10000,
          'im.message.reply'
        );
        if (resp && typeof resp.code === 'number' && resp.code !== 0) {
          console.error(`[FeishuCallback] Reply rejected: code=${resp.code} msg=${resp.msg || ''}`);
        } else {
          console.log(`[FeishuCallback] Reply sent to confirm ${value.action}`);
        }
      } catch (err) {
        console.error('[FeishuCallback] Failed to send reply:', err?.message || err);
      }
    }

    // ── Best-effort card update via PATCH (may not visually refresh) ──
    if (messageId) {
      try {
        const card = buildUpdatedCard(outcome, originalProposal);
        const resp = await withTimeout(
          client.im.message.patch({
            path: { message_id: messageId },
            data: { content: JSON.stringify(card) },
          }),
          10000,
          'im.message.patch'
        );
        if (resp && typeof resp.code === 'number' && resp.code !== 0) {
          console.error(`[FeishuCallback] Patch rejected: code=${resp.code} msg=${resp.msg || ''}`);
        } else {
          console.log(`[FeishuCallback] Card patched: ${messageId}`);
        }
      } catch (err) {
        console.error('[FeishuCallback] Patch failed (non-fatal):', err?.message || err);
      }
    }

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
