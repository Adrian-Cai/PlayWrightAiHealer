/**
 * AI Healer Adapter — Playwright 动作入口层。
 *
 * 本文件连接“测试用例”和“自愈核心”：
 * - 对外提供 aiClick/aiAssert/aiFill/aiLocate 兼容旧入口；
 * - 对外提供 clickByKey/assertVisibleByKey/fillByKey/locateByKey 推荐入口；
 * - 原 Locator 失败后调用 healer-core.ts；
 * - ByKey 入口在自愈成功或失败后记录 Proposal，供飞书审核卡片使用。
 *
 * 分层边界：
 * - healer-core.ts 只负责自愈编排，不知道 locatorKey，也不写 Proposal；
 * - ai-healer.ts 负责把测试语义、locatorKey、TestInfo 转换为 HealInput/Proposal；
 * - 本文件不直接发送飞书消息，也不创建 PR。
 */

import { expect, Page, TestInfo } from '@playwright/test';
import { HealEvent, HealInput } from '../skills/self-healing-locator/contract';
import { healCache } from './heal-cache';
import { healEventBus } from './heal-event-bus';
import { callAIForHeal } from './openai-client';
import { capturePageState } from './capture-state';
import { validateHeal } from './quality-gate';
import { getLocator } from './locator-repository';
import { addProposal } from './healer-proposal-store';
import { getJenkinsUrl, getRunId } from './healer-config';
import { HealResult, healLocator } from './healer-core';

export { HealResult, healCache, healEventBus };

/**
 * 调用自愈核心的内部适配函数。
 *
 * 这里把真实依赖注入给 healer-core：缓存、DOM 抓取、AI 客户端、Quality Gate 和事件发送。
 * 这样 healer-core 不需要 import 任何具体外围实现，便于单测和分层维护。
 */
async function heal(
  page: Page,
  input: HealInput,
  testInfo?: TestInfo,
  useLocator?: (locator: string) => Promise<void>
): Promise<HealResult> {
  return healLocator(
    page,
    input,
    {
      getCached: (originalLocator, pageUrl) => healCache.get(originalLocator, pageUrl),
      setCached: (originalLocator, pageUrl, output) =>
        healCache.set(originalLocator, pageUrl, output),
      capturePageState,
      callAIForHeal,
      validateHeal,
      emit: (event) => emitEvent(page, event, testInfo),
    },
    { useLocator }
  );
}

/**
 * 补齐事件上下文后发往事件总线。
 *
 * healer-core 只产生通用 HealEvent；这里补充 testName/Jenkins URL 等执行环境信息。
 */
async function emitEvent(
  page: Page,
  event: Omit<HealEvent, 'testName' | 'jenkinsUrl'>,
  testInfo?: TestInfo
): Promise<void> {
  const fullEvent: HealEvent = {
    ...event,
    testName: testInfo?.title || page.context().browser()?.browserType().name(),
    jenkinsUrl: getJenkinsUrl(),
  };

  await healEventBus.emit(fullEvent);
}

/** 可见性断言辅助函数，支持可选 expectedText。 */
async function expectVisibleLocator(
  page: Page,
  locator: string,
  timeout: number,
  expectedText?: string
): Promise<void> {
  const target = page.locator(locator).first();
  await expect(target).toBeVisible({ timeout });
  if (expectedText) {
    await expect(target).toContainText(expectedText, { timeout });
  }
}

/**
 * locate 动作要求 Locator 唯一且可见。
 * 这比普通 first() 更严格，避免把多匹配 Locator 误认为可用。
 */
async function expectUniqueVisibleLocator(
  page: Page,
  locator: string,
  timeout: number
): Promise<void> {
  const target = page.locator(locator);
  const count = await target.count();
  if (count !== 1) {
    throw new Error(`Locator must match exactly 1 element, got ${count}: ${locator}`);
  }
  await expect(target.first()).toBeVisible({ timeout });
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 自愈失败时保留两类错误：
 * - 原始 Locator 为什么失败；
 * - AI 自愈为什么失败。
 * 这样排查时不会只看到 AI 错误而丢失最初失败现场。
 */
function throwWithHealContext(originError: unknown, healError: unknown): never {
  throw new Error(
    `${toErrorMessage(originError)}\n\nHeal failed: ${toErrorMessage(healError)}`
  );
}

/**
 * 兼容旧入口：直接传 Locator。
 *
 * 新用例优先使用 clickByKey，因为 ByKey 才能记录 locatorKey 并进入人工审核闭环。
 */
export async function aiClick(
  page: Page,
  locator: string,
  description: string,
  testInfo?: TestInfo,
  options?: { timeout?: number }
): Promise<void> {
  const timeout = options?.timeout || 5000;

  try {
    await page.locator(locator).click({ timeout });
    return;
  } catch (originError) {
    console.warn(`[aiClick] Original locator failed: ${locator}`, originError);
    await heal(
      page,
      {
        originalLocator: locator,
        description,
        pageUrl: page.url(),
        action: 'click',
        timeoutMs: timeout,
        errorMessage: toErrorMessage(originError),
      },
      testInfo,
      (healedLocator) => page.locator(healedLocator).click({ timeout })
    );
  }
}

/** 兼容旧入口：直接传 Locator 做可见性/文本断言。 */
export async function aiAssert(
  page: Page,
  locator: string,
  description: string,
  testInfo?: TestInfo,
  options?: { timeout?: number; expectedText?: string }
): Promise<void> {
  const timeout = options?.timeout || 5000;

  try {
    await expectVisibleLocator(page, locator, timeout, options?.expectedText);
    return;
  } catch (originError) {
    console.warn(`[aiAssert] Original locator failed: ${locator}`, originError);
    await heal(
      page,
      {
        originalLocator: locator,
        description,
        pageUrl: page.url(),
        action: 'assert',
        timeoutMs: timeout,
        expectedText: options?.expectedText,
        errorMessage: toErrorMessage(originError),
      },
      testInfo,
      (healedLocator) =>
        expectVisibleLocator(page, healedLocator, timeout, options?.expectedText)
    );
  }
}

/** 兼容旧入口：直接传 Locator 执行 fill。 */
export async function aiFill(
  page: Page,
  locator: string,
  description: string,
  value: string,
  testInfo?: TestInfo,
  options?: { timeout?: number }
): Promise<void> {
  const timeout = options?.timeout || 5000;

  try {
    await page.locator(locator).fill(value, { timeout });
    return;
  } catch (originError) {
    console.warn(`[aiFill] Original locator failed: ${locator}`, originError);
    await heal(
      page,
      {
        originalLocator: locator,
        description,
        pageUrl: page.url(),
        action: 'fill',
        timeoutMs: timeout,
        fillValue: value,
        errorMessage: toErrorMessage(originError),
      },
      testInfo,
      (healedLocator) => page.locator(healedLocator).fill(value, { timeout })
    );
  }
}

/** 兼容旧入口：返回一个唯一可见的 Locator 字符串。 */
export async function aiLocate(
  page: Page,
  locator: string,
  description: string,
  testInfo?: TestInfo,
  options?: { timeout?: number }
): Promise<string> {
  const timeout = options?.timeout || 5000;

  try {
    await expectUniqueVisibleLocator(page, locator, timeout);
    return locator;
  } catch (originError) {
    console.warn(`[aiLocate] Original locator failed: ${locator}`, originError);
    const result = await heal(
      page,
      {
        originalLocator: locator,
        description,
        pageUrl: page.url(),
        action: 'locate',
        timeoutMs: timeout,
        errorMessage: toErrorMessage(originError),
      },
      testInfo,
      (healedLocator) => expectUniqueVisibleLocator(page, healedLocator, timeout)
    );
    return result.locator;
  }
}

interface ProposalMeta {
  locatorKey: string;
  elementName: string;
  action: 'click' | 'assert' | 'fill' | 'locate';
  testInfo?: TestInfo;
  page: Page;
}

/**
 * 将 ByKey 自愈结果写入 Proposal Store。
 *
 * 成功时写 pending proposal，等待飞书人工审核；失败时写 failed proposal，留下审计记录。
 * 记录 Proposal 失败不应影响测试主错误抛出，因此这里只打 warning。
 */
function recordProposal(
  meta: ProposalMeta,
  oldLocator: string,
  result: HealResult | null,
  errorDetail?: string
): void {
  try {
    addProposal({
      runId: getRunId(),
      testName: meta.testInfo?.title,
      testFile: meta.testInfo?.file,
      pageUrl: meta.page.url(),
      locatorKey: meta.locatorKey,
      elementName: meta.elementName,
      action: meta.action,
      oldLocator,
      newLocator: result?.output.locator,
      confidence: result?.output.confidence,
      reason: result?.output.reason,
      errorDetail,
    });
  } catch (err) {
    console.warn('[ai-healer] failed to record proposal:', err);
  }
}

/**
 * 推荐入口：通过 locatorKey 执行 click。
 *
 * 流程：读取正式 Locator → 原动作失败 → AI 自愈重试 → 记录待审核 Proposal。
 */
export async function aiClickByKey(
  page: Page,
  locatorKey: string,
  description: string,
  testInfo?: TestInfo,
  options?: { timeout?: number }
): Promise<void> {
  const timeout = options?.timeout || 5000;
  const locator = getLocator(locatorKey);
  const meta: ProposalMeta = { locatorKey, elementName: description, action: 'click', testInfo, page };

  try {
    await page.locator(locator).click({ timeout });
  } catch (originError) {
    console.warn(`[aiClickByKey] Original locator failed: ${locator}`, originError);
    try {
      const result = await heal(
        page,
        {
          originalLocator: locator,
          locatorKey,
          description,
          pageUrl: page.url(),
          action: 'click',
          timeoutMs: timeout,
          errorMessage: toErrorMessage(originError),
        },
        testInfo,
        (healedLocator) => page.locator(healedLocator).click({ timeout })
      );
      recordProposal(meta, locator, result);
    } catch (healError) {
      recordProposal(meta, locator, null, toErrorMessage(healError));
      throwWithHealContext(originError, healError);
    }
  }
}

/** 推荐入口：通过 locatorKey 执行可见性/文本断言。 */
export async function aiAssertByKey(
  page: Page,
  locatorKey: string,
  description: string,
  testInfo?: TestInfo,
  options?: { timeout?: number; expectedText?: string }
): Promise<void> {
  const timeout = options?.timeout || 5000;
  const locator = getLocator(locatorKey);
  const meta: ProposalMeta = { locatorKey, elementName: description, action: 'assert', testInfo, page };

  try {
    await expectVisibleLocator(page, locator, timeout, options?.expectedText);
  } catch (originError) {
    console.warn(`[aiAssertByKey] Original locator failed: ${locator}`, originError);
    try {
      const result = await heal(
        page,
        {
          originalLocator: locator,
          locatorKey,
          description,
          pageUrl: page.url(),
          action: 'assert',
          timeoutMs: timeout,
          expectedText: options?.expectedText,
          errorMessage: toErrorMessage(originError),
        },
        testInfo,
        (healedLocator) =>
          expectVisibleLocator(page, healedLocator, timeout, options?.expectedText)
      );
      recordProposal(meta, locator, result);
    } catch (healError) {
      recordProposal(meta, locator, null, toErrorMessage(healError));
      throwWithHealContext(originError, healError);
    }
  }
}

/** 推荐入口：通过 locatorKey 执行 fill。 */
export async function aiFillByKey(
  page: Page,
  locatorKey: string,
  description: string,
  value: string,
  testInfo?: TestInfo,
  options?: { timeout?: number }
): Promise<void> {
  const timeout = options?.timeout || 5000;
  const locator = getLocator(locatorKey);
  const meta: ProposalMeta = { locatorKey, elementName: description, action: 'fill', testInfo, page };

  try {
    await page.locator(locator).fill(value, { timeout });
  } catch (originError) {
    console.warn(`[aiFillByKey] Original locator failed: ${locator}`, originError);
    try {
      const result = await heal(
        page,
        {
          originalLocator: locator,
          locatorKey,
          description,
          pageUrl: page.url(),
          action: 'fill',
          timeoutMs: timeout,
          fillValue: value,
          errorMessage: toErrorMessage(originError),
        },
        testInfo,
        (healedLocator) => page.locator(healedLocator).fill(value, { timeout })
      );
      recordProposal(meta, locator, result);
    } catch (healError) {
      recordProposal(meta, locator, null, toErrorMessage(healError));
      throwWithHealContext(originError, healError);
    }
  }
}

/** 推荐入口：通过 locatorKey 获取唯一可见 Locator。 */
export async function aiLocateByKey(
  page: Page,
  locatorKey: string,
  description: string,
  testInfo?: TestInfo,
  options?: { timeout?: number }
): Promise<string> {
  const timeout = options?.timeout || 5000;
  const locator = getLocator(locatorKey);
  const meta: ProposalMeta = { locatorKey, elementName: description, action: 'locate', testInfo, page };

  try {
    await expectUniqueVisibleLocator(page, locator, timeout);
    return locator;
  } catch (originError) {
    console.warn(`[aiLocateByKey] Original locator failed: ${locator}`, originError);
    try {
      const result = await heal(
        page,
        {
          originalLocator: locator,
          locatorKey,
          description,
          pageUrl: page.url(),
          action: 'locate',
          timeoutMs: timeout,
          errorMessage: toErrorMessage(originError),
        },
        testInfo,
        (healedLocator) => expectUniqueVisibleLocator(page, healedLocator, timeout)
      );
      recordProposal(meta, locator, result);
      return result.locator;
    } catch (healError) {
      recordProposal(meta, locator, null, toErrorMessage(healError));
      throwWithHealContext(originError, healError);
    }
  }
}

// 简短别名：新用例建议使用这些名字，旧的 aiXxxByKey 继续保留兼容。
export const clickByKey = aiClickByKey;
export const assertVisibleByKey = aiAssertByKey;
export const fillByKey = aiFillByKey;
export const locateByKey = aiLocateByKey;
