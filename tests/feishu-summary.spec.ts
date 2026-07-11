import { expect, test } from '@playwright/test';

import {
  buildCaseSummaryTemplateVariables,
  formatDuration,
  resolveNotificationRecipient,
} from '../utils/feishu-bot';

test.describe('Feishu summary routing', () => {
  test('routes test summaries to the configured chat', () => {
    expect(
      resolveNotificationRecipient('test-summary', {
        FEISHU_CHAT_ID: 'oc_group_chat',
        FEISHU_REVIEWER_OPEN_ID: 'ou_reviewer',
      })
    ).toEqual({ receiveId: 'oc_group_chat', receiveIdType: 'chat_id' });
  });

  test('routes locator reviews to the configured reviewer', () => {
    expect(
      resolveNotificationRecipient('locator-review', {
        FEISHU_CHAT_ID: 'oc_group_chat',
        FEISHU_REVIEWER_OPEN_ID: 'ou_reviewer',
      })
    ).toEqual({ receiveId: 'ou_reviewer', receiveIdType: 'open_id' });
  });
});

test.describe('Feishu summary template variables', () => {
  test('uses real run statistics, links, and duration', () => {
    const variables = buildCaseSummaryTemplateVariables({
      title: 'Playwright 自动化测试存在失败',
      status: 'error',
      total: 53,
      passed: 50,
      failed: 1,
      skipped: 2,
      healTriggeredCount: 2,
      healSuccessCount: 2,
      healFailedCount: 0,
      pendingCount: 2,
      durationMs: 102_000,
      reportUrl: 'https://jenkins.example/report/',
      reportArchiveUrl: 'https://jenkins.example/report.zip',
    });

    expect(variables).toMatchObject({
      total: '53',
      passed: '50',
      failed: '1',
      skipped: '2',
      heal_success: '2',
      pending_count: '2',
      duration_ms: '102000',
      duration: '1m42s',
      report_url: 'https://jenkins.example/report/',
      report_archive_url: 'https://jenkins.example/report.zip',
    });
  });
});

test.describe('formatDuration', () => {
  test('formats zero milliseconds', () => {
    expect(formatDuration(0)).toBe('0s');
  });

  test('formats a duration shorter than one minute', () => {
    expect(formatDuration(38_400)).toBe('38s');
  });

  test('formats a duration longer than one minute', () => {
    expect(formatDuration(102_000)).toBe('1m42s');
  });
});
