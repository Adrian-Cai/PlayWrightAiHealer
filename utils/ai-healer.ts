/**
 * AI Healer — Core orchestration for self-healing locators
 * Orchestrates: cache → capture → AI → quality gate → retry → events
 */

import { Page } from '@playwright/test';
import * as dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { HealInput, HealEvent } from '../skills/self-healing-locator/contract';
import { healEventBus } from './heal-event-bus';
import { healCache } from './heal-cache';
import { callAIForHeal } from './openai-client';
import { capturePageState } from './capture-state';
import { validateHeal, isPassed, getOutput, getErrors } from './quality-gate';

dotenv.config();

/**
 * Core heal function — orchestrates the entire self-healing flow
 */
async function heal(page: Page, input: HealInput): Promise<string> {
  const startTime = Date.now();
  const eventId = uuidv4();

  // Emit start event
  await emitEvent(page, {
    id: eventId,
    type: 'HEAL_START',
    timestamp: new Date().toISOString(),
    input,
    retryCount: 0,
    durationMs: 0,
    cacheHit: false,
  });

  try {
    // Step 1: Check cache
    const cachedOutput = healCache.get(input.originalLocator, input.pageUrl);
    if (cachedOutput) {
      await emitEvent(page, {
        id: eventId,
        type: 'CACHE_HIT',
        timestamp: new Date().toISOString(),
        input,
        output: cachedOutput,
        retryCount: 0,
        durationMs: Date.now() - startTime,
        cacheHit: true,
        finalLocator: cachedOutput.locator,
      });
      return cachedOutput.locator;
    }

    // Step 2: Capture page state
    const snapshot = await capturePageState(page);
    await emitEvent(page, {
      id: eventId,
      type: 'STATE_CAPTURED',
      timestamp: new Date().toISOString(),
      input,
      retryCount: 0,
      durationMs: Date.now() - startTime,
      cacheHit: false,
    });

    // Step 3: Call AI for heal
    const aiOutput = await callAIForHeal(input);
    await emitEvent(page, {
      id: eventId,
      type: 'AI_CALLED',
      timestamp: new Date().toISOString(),
      input,
      output: aiOutput,
      retryCount: 0,
      durationMs: Date.now() - startTime,
      cacheHit: false,
    });

    // Step 4: Validate output
    const validationResult = await validateHeal(page, input, aiOutput);
    if (!isPassed(validationResult)) {
      await emitEvent(page, {
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
      });

      throw new Error(`Quality gate failed: ${getErrors(validationResult).join('; ')}`);
    }

    await emitEvent(page, {
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
    });

    // Step 5: Cache and return
    healCache.set(input.originalLocator, input.pageUrl, aiOutput);

    await emitEvent(page, {
      id: eventId,
      type: 'HEAL_SUCCESS',
      timestamp: new Date().toISOString(),
      input,
      output: aiOutput,
      retryCount: 0,
      durationMs: Date.now() - startTime,
      cacheHit: false,
      finalLocator: aiOutput.locator,
    });

    return aiOutput.locator;
  } catch (error) {
    await emitEvent(page, {
      id: eventId,
      type: 'HEAL_FAILED',
      timestamp: new Date().toISOString(),
      input,
      error: String(error),
      retryCount: 0,
      durationMs: Date.now() - startTime,
      cacheHit: false,
    });

    throw error;
  }
}

/**
 * Emit an event to the event bus
 */
async function emitEvent(page: Page, event: Omit<HealEvent, 'testName' | 'jenkinsUrl'>) {
  const fullEvent: HealEvent = {
    ...event,
    testName: page.context().browser?.browserType.name,
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
  const healedLocator = await heal(page, {
    originalLocator: locator,
    description,
    pageUrl: page.url(),
    action: 'click',
    timeoutMs: timeout,
  });

  await page.locator(healedLocator).click({ timeout });
}

/**
 * aiAssert — Assert element visibility/text with healing
 */
export async function aiAssert(
  page: Page,
  locator: string,
  description: string,
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
  const healedLocator = await heal(page, {
    originalLocator: locator,
    description,
    pageUrl: page.url(),
    action: 'assert',
    timeoutMs: timeout,
    expectedText: options?.expectedText,
  });

  await page.locator(healedLocator).first().isVisible({ timeout });
}

/**
 * aiFill — Fill input element with healing
 */
export async function aiFill(
  page: Page,
  locator: string,
  description: string,
  value: string,
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
  const healedLocator = await heal(page, {
    originalLocator: locator,
    description,
    pageUrl: page.url(),
    action: 'fill',
    timeoutMs: timeout,
    fillValue: value,
  });

  await page.locator(healedLocator).fill(value, { timeout });
}

/**
 * aiLocate — Get healed locator without performing action
 */
export async function aiLocate(
  page: Page,
  locator: string,
  description: string,
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
  const healedLocator = await heal(page, {
    originalLocator: locator,
    description,
    pageUrl: page.url(),
    action: 'locate',
    timeoutMs: timeout,
  });

  return healedLocator;
}

export { healEventBus, healCache };