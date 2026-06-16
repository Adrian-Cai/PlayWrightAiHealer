import axios from 'axios';
import * as dotenv from 'dotenv';

dotenv.config();

const APP_ID = process.env.FEISHU_APP_ID || '';
const APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const CHAT_ID = process.env.FEISHU_CHAT_ID || '';

let tenantAccessToken: string = '';
let tokenExpiry: number = 0;

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

interface FeishuLine {
  tag: string;
  text?: string;
  un_escape?: boolean;
  style?: string[];
}

export async function sendHealNotification(opts: {
  title: string;
  status: 'warning' | 'error' | 'success';
  description: string;
  originalLocator: string;
  healedLocator?: string;
  errorDetail?: string;
  pageUrl?: string;
}) {
  if (!APP_ID || !APP_SECRET || !CHAT_ID) {
    console.log(`[Feishu] Skipping notification (not configured): ${opts.title}`);
    return;
  }

  const statusEmoji = { warning: '⚠️', error: '❌', success: '✅' };
  const statusText = { warning: '警告', error: '失败', success: '成功' };

  const lines: FeishuLine[][] = [];

  lines.push([{ tag: 'text', text: `📋 元素: ${opts.description}` }]);
  lines.push([{ tag: 'text', text: `🔍 原始定位器: ${opts.originalLocator}` }]);

  if (opts.healedLocator) {
    lines.push([{ tag: 'text', text: `🔧 AI 修复定位器: ${opts.healedLocator}` }]);
  }

  if (opts.errorDetail) {
    const shortError = opts.errorDetail.split('\n')[0].substring(0, 100);
    lines.push([{ tag: 'text', text: `❗ 错误: ${shortError}` }]);
  }

  if (opts.pageUrl) {
    lines.push([{ tag: 'text', text: `🌐 页面: ${opts.pageUrl}` }]);
  }

  lines.push([{ tag: 'text', text: `📊 状态: ${statusEmoji[opts.status]} ${statusText[opts.status]}` }]);

  const token = await getTenantAccessToken();
  const payload = {
    receive_id: CHAT_ID,
    msg_type: 'post',
    content: JSON.stringify({
      zh_cn: {
        title: opts.title,
        content: lines,
      },
    }),
  };

  try {
    await axios.post(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
      payload,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    console.log(`[Feishu] Notification sent: ${opts.title}`);
  } catch (error: any) {
    console.error(`[Feishu] Error sending notification: ${error.message}`);
  }
}

export async function sendFeishuMessage(title: string, content: string, status: 'info' | 'success' | 'warning' | 'error' = 'info') {
  await sendHealNotification({
    title,
    status: status === 'error' ? 'error' : status === 'warning' ? 'warning' : 'success',
    description: content,
    originalLocator: '',
  });
}
