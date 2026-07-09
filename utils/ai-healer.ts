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

function throwWithHealContext(originError: unknown, healError: unknown): never {
  throw new Error(
    `${toErrorMessage(originError)}\n\nHeal failed: ${toErrorMessage(healError)}`
  );
}

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

export const clickByKey = aiClickByKey;
export const assertVisibleByKey = aiAssertByKey;
export const fillByKey = aiFillByKey;
export const locateByKey = aiLocateByKey;
