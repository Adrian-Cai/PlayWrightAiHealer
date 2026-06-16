import axios from 'axios';
import * as dotenv from 'dotenv';

dotenv.config();

export async function sendFeishuMessage(title: string, content: string, status: 'info' | 'success' | 'warning' | 'error' = 'info') {
  const webhookUrl = process.env.FEISHU_WEBHOOK_URL;
  if (!webhookUrl || webhookUrl === 'your_feishu_webhook_url_here') {
    console.log(`[Feishu] Skipping notification (URL not configured): ${title} - ${content}`);
    return;
  }

  const colorMap = {
    info: 'blue',
    success: 'green',
    warning: 'yellow',
    error: 'red',
  };

  const payload = {
    msg_type: 'post',
    content: {
      post: {
        zh_cn: {
          title: title,
          content: [
            [{ tag: 'text', text: content }],
            [{ tag: 'text', text: `Status: ${status.toUpperCase()}` }],
          ],
        },
      },
    },
  };

  try {
    await axios.post(webhookUrl, payload);
    console.log(`[Feishu] Notification sent: ${title}`);
  } catch (error) {
    console.error(`[Feishu] Error sending notification: ${error.message}`);
  }
}
