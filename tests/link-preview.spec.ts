import { test, expect } from '@playwright/test';
import {
  buildJenkinsReportPreview,
  extractUrlPreviewTarget,
  isJenkinsReportUrl,
} from '../utils/link-preview';

test('isJenkinsReportUrl accepts Jenkins Playwright HTML report links', () => {
  expect(
    isJenkinsReportUrl(
      'https://jenkins.wiac.xyz/job/playwright-ai-healer/42/Playwright_Report/'
    )
  ).toBe(true);
});

test('isJenkinsReportUrl accepts archived Playwright report zip links', () => {
  expect(
    isJenkinsReportUrl(
      'https://jenkins.wiac.xyz/job/playwright-ai-healer/42/artifact/playwright-report/*zip*/playwright-report.zip'
    )
  ).toBe(true);
});

test('isJenkinsReportUrl rejects unrelated hosts and paths', () => {
  expect(isJenkinsReportUrl('https://ai-case.wiac.xyz/')).toBe(false);
  expect(isJenkinsReportUrl('https://jenkins.wiac.xyz/job/demo/42/console')).toBe(false);
});

test('buildJenkinsReportPreview returns inline title for Jenkins reports', () => {
  const preview = buildJenkinsReportPreview(
    'https://jenkins.wiac.xyz/job/playwright-ai-healer/42/Playwright_Report/'
  );

  expect(preview).toEqual({
    inline: {
      title: 'Playwright 测试报告',
    },
  });
});

test('buildJenkinsReportPreview returns empty response for unrelated links', () => {
  expect(buildJenkinsReportPreview('https://ai-case.wiac.xyz/')).toEqual({});
});

test('extractUrlPreviewTarget reads common Feishu callback payload shapes', () => {
  expect(extractUrlPreviewTarget({ url: 'https://jenkins.wiac.xyz/a/Playwright_Report/' })).toBe(
    'https://jenkins.wiac.xyz/a/Playwright_Report/'
  );
  expect(
    extractUrlPreviewTarget({
      event: {
        url: 'https://jenkins.wiac.xyz/a/artifact/playwright-report/*zip*/playwright-report.zip',
      },
    })
  ).toBe('https://jenkins.wiac.xyz/a/artifact/playwright-report/*zip*/playwright-report.zip');
});
