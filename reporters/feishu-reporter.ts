/**
 * Feishu Reporter — Playwright custom reporter
 * Reads the JSONL event sink at end-of-run and sends ONE summary card to Feishu
 * Aggregates: total/passed/failed/skipped + heal triggered/success/failed + failed-case details
 */

import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';

import { readHealEvents } from '../utils/healer-collector';
import { readProposals } from '../utils/healer-proposal-store';
import { sendCaseSummaryNotification, sendReviewCard } from '../utils/feishu-bot';

interface CaseResult {
  title: string;
  file: string;
  status: string;
  error?: string;
}

class FeishuReporter implements Reporter {
  private total = 0;
  private passed = 0;
  private failed = 0;
  private skipped = 0;
  private caseResults: CaseResult[] = [];

  onBegin(config: FullConfig, suite: Suite): void {
    this.total = suite.allTests().length;
    console.log(`[FeishuReporter] Test run started. Total tests: ${this.total}`);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status === 'passed') {
      this.passed++;
    } else if (result.status === 'failed' || result.status === 'timedOut') {
      this.failed++;
      this.caseResults.push({
        title: test.title,
        file: test.location.file,
        status: result.status,
        error: result.error?.message,
      });
    } else if (result.status === 'skipped') {
      this.skipped++;
    }
  }

  async onEnd(result: FullResult): Promise<void> {
    const healEvents = readHealEvents();

    const healTriggeredCount = healEvents.filter((e) => e.type === 'HEAL_START').length;
    const healSuccessCount = healEvents.filter((e) => e.type === 'HEAL_SUCCESS').length;
    const healFailedCount = healEvents.filter(
      (e) => e.type === 'HEAL_FAILED' || e.type === 'VALIDATION_FAILED'
    ).length;

    const status: 'success' | 'error' | 'warning' =
      result.status === 'passed' ? 'success' : this.failed > 0 ? 'error' : 'warning';

    const title =
      result.status === 'passed'
        ? 'Playwright 自动化测试通过'
        : 'Playwright 自动化测试存在失败';

    // 对外报告地址优先用显式 PLAYWRIGHT_REPORT_URL；否则基于 Jenkins 构建地址拼接已发布报告路径
    // （publishHTML reportName='Playwright_Report'）。旧的 'playwright-report/' 是工作区目录，
    // Jenkins 不会以 URL 形式提供，会返回 502，因此不能直接把 BUILD_URL 当报告链接。
    const jenkinsBase =
      process.env.JENKINS_PUBLIC_URL ||
      process.env.BUILD_URL ||
      process.env.JENKINS_BUILD_URL ||
      '';
    const normalizedBase =
      jenkinsBase === '' || jenkinsBase.endsWith('/')
        ? jenkinsBase
        : `${jenkinsBase}/`;
    const reportUrl =
      process.env.PLAYWRIGHT_REPORT_URL ||
      (normalizedBase ? `${normalizedBase}Playwright_Report/` : '');
    // 归档后的报告压缩包：浏览器内 HTML 报告受 Jenkins CSP 限制白屏时，可下载解压本地打开 index.html
    const reportArchiveUrl = normalizedBase
      ? `${normalizedBase}artifact/playwright-report/*zip*/playwright-report.zip`
      : '';

    // Every run sends a compact group summary. Pending proposals trigger an
    // additional private review card for the configured locator owner.
    const proposals = readProposals();
    const pendingCount = proposals.filter((p) => p.status === 'pending').length;

    await sendCaseSummaryNotification({
      title,
      status,
      total: this.total,
      passed: this.passed,
      failed: this.failed,
      skipped: this.skipped,
    });
    console.log(
      `[FeishuReporter] Summary sent. total=${this.total} passed=${this.passed} failed=${this.failed} skipped=${this.skipped} | heal success=${healSuccessCount} failed=${healFailedCount}`
    );

    if (pendingCount > 0) {
      await sendReviewCard({
        title: '⚠️ Playwright AI 自愈待审核',
        status: 'warning',
        total: this.total,
        passed: this.passed,
        failed: this.failed,
        skipped: this.skipped,
        proposals,
        reportUrl,
        reportArchiveUrl,
      });
      console.log(
        `[FeishuReporter] Review card sent with ${pendingCount} pending proposal(s).`
      );
    }
  }
}

export default FeishuReporter;
