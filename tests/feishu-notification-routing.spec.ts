import { expect, test } from '@playwright/test';
import {
  buildCaseSummaryElements,
  resolveNotificationRecipient,
  shouldSendHealEventNotifications,
} from '../utils/feishu-bot';

test.describe('Feishu notification routing', () => {
  test('sends test summaries to the configured group chat', () => {
    expect(
      resolveNotificationRecipient('test-summary', {
        FEISHU_CHAT_ID: 'oc_summary_group',
        FEISHU_REVIEWER_OPEN_ID: 'ou_reviewer',
      })
    ).toEqual({ receiveId: 'oc_summary_group', receiveIdType: 'chat_id' });
  });

  test('sends locator reviews to the configured reviewer direct message', () => {
    expect(
      resolveNotificationRecipient('locator-review', {
        FEISHU_CHAT_ID: 'oc_summary_group',
        FEISHU_REVIEWER_OPEN_ID: 'ou_reviewer',
      })
    ).toEqual({ receiveId: 'ou_reviewer', receiveIdType: 'open_id' });
  });

  test('does not resolve a recipient when the scenario configuration is missing', () => {
    expect(resolveNotificationRecipient('test-summary', {})).toBeUndefined();
    expect(resolveNotificationRecipient('locator-review', {})).toBeUndefined();
  });

  test('keeps self-healing event notifications disabled unless explicitly enabled', () => {
    expect(shouldSendHealEventNotifications({})).toBe(false);
    expect(shouldSendHealEventNotifications({ FEISHU_SEND_HEAL_EVENTS: 'true' })).toBe(true);
  });

  test('builds a compact test summary without action buttons or healing details', () => {
    const elements = buildCaseSummaryElements({
      title: '测试通过',
      status: 'success',
      total: 8,
      passed: 7,
      failed: 1,
      skipped: 0,
    });

    expect(elements).toHaveLength(2);
    expect(elements.some((element) => element.tag === 'action')).toBe(false);
    expect(JSON.stringify(elements)).not.toContain('自愈成功');
  });
});
