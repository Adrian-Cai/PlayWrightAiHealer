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
import { sendCaseSummaryNotification } from '../utils/feishu-bot';

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

    const reportUrl =
      process.env.PLAYWRIGHT_REPORT_URL ||
      process.env.BUILD_URL ||
      process.env.JENKINS_BUILD_URL ||
      '';

    await sendCaseSummaryNotification({
      title,
      status,
      total: this.total,
      passed: this.passed,
      failed: this.failed,
      skipped: this.skipped,
      healTriggeredCount,
      healSuccessCount,
      healFailedCount,
      failedCases: this.caseResults,
      healEvents,
      reportUrl,
    });

    console.log(
      `[FeishuReporter] Summary sent. total=${this.total} passed=${this.passed} failed=${this.failed} skipped=${this.skipped} | heal success=${healSuccessCount} failed=${healFailedCount}`
    );
  }
}

export default FeishuReporter;
