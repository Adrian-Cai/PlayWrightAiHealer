/**
 * AI Healer — Core orchestration for self-healing locators
 * Orchestrates: cache → capture → AI → quality gate → retry → events
 */

import { randomUUID } from 'crypto';
import { Page, TestInfo } from '@playwright/test';
import * as dotenv from 'dotenv';
import { HealInput, HealEvent, HealOutput } from '../skills/self-healing-locator/contract';
import { healEventBus } from './heal-event-bus';
import { healCache } from './heal-cache';
import { callAIForHeal } from './openai-client';
import { capturePageState } from './capture-state';
import { validateHeal, isPassed, getOutput, getErrors } from './quality-gate';
import { initHealerCollector } from './healer-collector';
import { getLocator } from './locator-repository';
import { addProposal } from './healer-proposal-store';

dotenv.config();

// Initialize JSONL collector so heal events are written to test-results/ai-healer-events.jsonl
// The Feishu Reporter reads this file in onEnd() to produce a single summary card.
// Safe to call multiple times — initHealerCollector is idempotent.
initHealerCollector();

/**
 * Structured heal result returned by heal(). Carries enough info for the
 * ByKey wrappers to record a HealProposal (oldLocator → newLocator + confidence + reason).
 */
export interface HealResult {
  /** The locator to use (from AI or cache). */
  locator: string;
  /** The full AI output (locator / strategy / confidence / reason). */
  output: HealOutput;
  /** Whether this result came from the in-run cache. */
  cacheHit: boolean;
}

/**
 * Core heal function — orchestrates the entire self-healing flow
 */
async function heal(
  page: Page,
  input: HealInput,
  testInfo?: TestInfo
): Promise<HealResult> {
  const startTime = Date.now();
  const eventId = randomUUID();

  // Emit start event
  await emitEvent(
    page,
    {
      id: eventId,
      type: 'HEAL_START',
      timestamp: new Date().toISOString(),
      input,
      retryCount: 0,
      durationMs: 0,
      cacheHit: false,
    },
    testInfo
  );

  try {
    // Step 1: Check cache
    const cachedOutput = healCache.get(input.originalLocator, input.pageUrl);
    if (cachedOutput) {
      await emitEvent(
        page,
        {
          id: eventId,
          type: 'CACHE_HIT',
          timestamp: new Date().toISOString(),
          input,
          output: cachedOutput,
          retryCount: 0,
          durationMs: Date.now() - startTime,
          cacheHit: true,
          finalLocator: cachedOutput.locator,
        },
        testInfo
      );
      return { locator: cachedOutput.locator, output: cachedOutput, cacheHit: true };
    }

    // Step 2: Capture page state
    const snapshot = await capturePageState(page);
    await emitEvent(
      page,
      {
        id: eventId,
        type: 'STATE_CAPTURED',
        timestamp: new Date().toISOString(),
        input,
        retryCount: 0,
        durationMs: Date.now() - startTime,
        cacheHit: false,
      },
      testInfo
    );

    // Step 3: Call AI for heal
    const aiOutput = await callAIForHeal(input);
    await emitEvent(
      page,
      {
        id: eventId,
        type: 'AI_CALLED',
        timestamp: new Date().toISOString(),
        input,
        output: aiOutput,
        retryCount: 0,
        durationMs: Date.now() - startTime,
        cacheHit: false,
      },
      testInfo
    );

    // Step 4: Validate output
    const validationResult = await validateHeal(page, input, aiOutput);
    if (!isPassed(validationResult)) {
      await emitEvent(
        page,
        {
          id: eventId,
          type: 'VALIDATION_FAILED',
          timestamp: new Date().toISOString(),
          input,
          output: aiOutput,
          validation: {
            valid: false,
            errors: getErrors(validationResult),
          },
          error: getErrors(validationResult).join('; '),
          retryCount: 0,
          durationMs: Date.now() - startTime,
          cacheHit: false,
        },
        testInfo
      );

      throw new Error(`Quality gate failed: ${getErrors(validationResult).join('; ')}`);
    }

    await emitEvent(
      page,
      {
        id: eventId,
        type: 'VALIDATION_PASSED',
        timestamp: new Date().toISOString(),
        input,
        output: aiOutput,
        validation: {
          valid: true,
          errors: [],
        },
        retryCount: 0,
        durationMs: Date.now() - startTime,
        cacheHit: false,
      },
      testInfo
    );

    // Step 5: Cache and return
    healCache.set(input.originalLocator, input.pageUrl, aiOutput);

    await emitEvent(
      page,
      {
        id: eventId,
        type: 'HEAL_SUCCESS',
        timestamp: new Date().toISOString(),
        input,
        output: aiOutput,
        retryCount: 0,
        durationMs: Date.now() - startTime,
        cacheHit: false,
        finalLocator: aiOutput.locator,
      },
      testInfo
    );

    return { locator: aiOutput.locator, output: aiOutput, cacheHit: false };
  } catch (error) {
    await emitEvent(
      page,
      {
        id: eventId,
        type: 'HEAL_FAILED',
        timestamp: new Date().toISOString(),
        input,
        error: String(error),
        retryCount: 0,
        durationMs: Date.now() - startTime,
        cacheHit: false,
      },
      testInfo
    );

    throw error;
  }
}

/**
 * Emit an event to the event bus
 */
async function emitEvent(
  page: Page,
  event: Omit<HealEvent, 'testName' | 'jenkinsUrl'>,
  testInfo?: TestInfo
) {
  const fullEvent: HealEvent = {
    ...event,
    testName: testInfo?.title || page.context().browser()?.browserType().name(),
    jenkinsUrl: process.env.JENKINS_BUILD_URL,
  };

  await healEventBus.emit(fullEvent);
}

/**
 * aiClick — Click element with healing
 */
export async function aiClick(
  page: Page,
  locator: string,
  description: string,
  testInfo?: TestInfo,
  options?: { timeout?: number }
): Promise<void> {
  const timeout = options?.timeout || 5000;

  // Try original locator first
  try {
    await page.locator(locator).click({ timeout });
    return;
  } catch (error) {
    console.warn(`[aiClick] Original locator failed: ${locator}`, error);
  }

  // Try healing
  const result = await heal(
    page,
    {
      originalLocator: locator,
      description,
      pageUrl: page.url(),
      action: 'click',
      timeoutMs: timeout,
    },
    testInfo
  );

  await page.locator(result.locator).click({ timeout });
}

/**
 * aiAssert — Assert element visibility/text with healing
 */
export async function aiAssert(
  page: Page,
  locator: string,
  description: string,
  testInfo?: TestInfo,
  options?: { timeout?: number; expectedText?: string }
): Promise<void> {
  const timeout = options?.timeout || 5000;

  // Try original locator first
  try {
    await page.locator(locator).first().isVisible({ timeout });
    return;
  } catch (error) {
    console.warn(`[aiAssert] Original locator failed: ${locator}`, error);
  }

  // Try healing
  const result = await heal(
    page,
    {
      originalLocator: locator,
      description,
      pageUrl: page.url(),
      action: 'assert',
      timeoutMs: timeout,
      expectedText: options?.expectedText,
    },
    testInfo
  );

  await page.locator(result.locator).first().isVisible({ timeout });
}

/**
 * aiFill — Fill input element with healing
 */
export async function aiFill(
  page: Page,
  locator: string,
  description: string,
  value: string,
  testInfo?: TestInfo,
  options?: { timeout?: number }
): Promise<void> {
  const timeout = options?.timeout || 5000;

  // Try original locator first
  try {
    await page.locator(locator).fill(value, { timeout });
    return;
  } catch (error) {
    console.warn(`[aiFill] Original locator failed: ${locator}`, error);
  }

  // Try healing
  const result = await heal(
    page,
    {
      originalLocator: locator,
      description,
      pageUrl: page.url(),
      action: 'fill',
      timeoutMs: timeout,
      fillValue: value,
    },
    testInfo
  );

  await page.locator(result.locator).fill(value, { timeout });
}

/**
 * aiLocate — Get healed locator without performing action
 */
export async function aiLocate(
  page: Page,
  locator: string,
  description: string,
  testInfo?: TestInfo,
  options?: { timeout?: number }
): Promise<string> {
  const timeout = options?.timeout || 5000;

  // Try original locator first
  try {
    const count = await page.locator(locator).count();
    if (count > 0) {
      return locator;
    }
  } catch (error) {
    console.warn(`[aiLocate] Original locator failed: ${locator}`, error);
  }

  // Try healing
  const result = await heal(
    page,
    {
      originalLocator: locator,
      description,
      pageUrl: page.url(),
      action: 'locate',
      timeoutMs: timeout,
    },
    testInfo
  );

  return result.locator;
}

export { healEventBus, healCache };

// ---------------------------------------------------------------------------
// ByKey wrappers — locators are resolved from locator-store.json by key
// ---------------------------------------------------------------------------
//
// These wrappers resolve the locator string from the central locator-store.json
// and, on heal success/failure, record a HealProposal for human review:
//   1. Locators live in one version-controlled file (locator-store.json)
//   2. The Feishu callback server (Phase 3) can replace a locator by editing
//      only that JSON file, never touching test code
//   3. AI never modifies spec files — it only suggests, humans approve
//
// On heal failure these wrappers throw the ORIGINAL locator error (not the
// AI/heal error) so the test report points at the real failure. A 'failed'
// proposal is still recorded for audit.

interface ProposalMeta {
  locatorKey: string;
  elementName: string;
  action: 'click' | 'assert' | 'fill' | 'locate';
  testInfo?: TestInfo;
  page: Page;
}

/**
 * Record a proposal after a heal attempt. Best-effort: proposal-store errors
 * are logged but never break the test flow.
 */
function recordProposal(
  meta: ProposalMeta,
  oldLocator: string,
  result: HealResult | null,
  errorDetail?: string
): void {
  try {
    addProposal({
      runId: process.env.RUN_ID,
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
    return;
  } catch (originError: any) {
    console.warn(`[aiClickByKey] Original locator failed: ${locator}`, originError);
    try {
      const result = await heal(
        page,
        { originalLocator: locator, locatorKey, description, pageUrl: page.url(), action: 'click', timeoutMs: timeout },
        testInfo
      );
      await page.locator(result.locator).click({ timeout });
      recordProposal(meta, locator, result);
    } catch (healError: any) {
      recordProposal(meta, locator, null, String(healError));
      throw originError;
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
    await page.locator(locator).first().isVisible({ timeout });
    return;
  } catch (originError: any) {
    console.warn(`[aiAssertByKey] Original locator failed: ${locator}`, originError);
    try {
      const result = await heal(
        page,
        { originalLocator: locator, locatorKey, description, pageUrl: page.url(), action: 'assert', timeoutMs: timeout, expectedText: options?.expectedText },
        testInfo
      );
      await page.locator(result.locator).first().isVisible({ timeout });
      recordProposal(meta, locator, result);
    } catch (healError: any) {
      recordProposal(meta, locator, null, String(healError));
      throw originError;
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
    return;
  } catch (originError: any) {
    console.warn(`[aiFillByKey] Original locator failed: ${locator}`, originError);
    try {
      const result = await heal(
        page,
        { originalLocator: locator, locatorKey, description, pageUrl: page.url(), action: 'fill', timeoutMs: timeout, fillValue: value },
        testInfo
      );
      await page.locator(result.locator).fill(value, { timeout });
      recordProposal(meta, locator, result);
    } catch (healError: any) {
      recordProposal(meta, locator, null, String(healError));
      throw originError;
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
    const count = await page.locator(locator).count();
    if (count > 0) {
      return locator;
    }
  } catch (originError: any) {
    console.warn(`[aiLocateByKey] Original locator failed: ${locator}`, originError);
    try {
      const result = await heal(
        page,
        { originalLocator: locator, locatorKey, description, pageUrl: page.url(), action: 'locate', timeoutMs: timeout },
        testInfo
      );
      recordProposal(meta, locator, result);
      return result.locator;
    } catch (healError: any) {
      recordProposal(meta, locator, null, String(healError));
      throw originError;
    }
  }

  // count === 0 path: locator exists syntactically but matches nothing → heal
  try {
    const result = await heal(
      page,
      { originalLocator: locator, locatorKey, description, pageUrl: page.url(), action: 'locate', timeoutMs: timeout },
      testInfo
    );
    recordProposal(meta, locator, result);
    return result.locator;
  } catch (healError: any) {
    recordProposal(meta, locator, null, String(healError));
    throw new Error(`aiLocateByKey: locator matched 0 elements and heal failed for key="${locatorKey}"`);
  }
}