/**
 * Quality Gate — Validate AI-generated locators before use
 * Checks: confidence threshold, unambiguous matching, text consistency
 */

import { Page } from '@playwright/test';
import { HealInput, HealOutput, QualityGateResult } from '../skills/self-healing-locator/contract';

const CONFIDENCE_THRESHOLD = 0.6;
const MAX_MATCHING_ELEMENTS = 1;

/**
 * Validate a healed locator before using it
 * Returns discriminated union: pass { status: 'pass', output } or fail { status: 'fail', errors }
 */
export async function validateHeal(
  page: Page,
  input: HealInput,
  output: HealOutput
): Promise<QualityGateResult> {
  const errors: string[] = [];

  // 1. Check confidence threshold
  if (output.confidence < CONFIDENCE_THRESHOLD) {
    errors.push(
      `Confidence ${output.confidence} is below threshold ${CONFIDENCE_THRESHOLD}`
    );
  }

  // 2. Try to locate element and check uniqueness
  try {
    const locatorElements = await page.locator(output.locator).count();

    if (locatorElements === 0) {
      // Early return: element doesn't exist, so subsequent text/enabled checks
      // are meaningless AND would hang waiting for actionability on a missing element.
      return {
        status: 'fail',
        errors: [`Locator matches 0 elements on page: ${output.locator}`],
      };
    } else if (locatorElements > MAX_MATCHING_ELEMENTS) {
      // Early return: not unique, text/enabled checks would be ambiguous.
      return {
        status: 'fail',
        errors: [
          `Locator matches ${locatorElements} elements (expected 1): ${output.locator}`,
        ],
      };
    }
  } catch (locatorError) {
    return {
      status: 'fail',
      errors: [`Locator is invalid or causes error: ${locatorError}`],
    };
  }

  // 3. If action expects text, verify text match
  if (input.expectedText && input.action === 'assert') {
    try {
      const locator = page.locator(output.locator).first();
      const actualText = await locator.textContent();

      if (!actualText || !actualText.includes(input.expectedText)) {
        errors.push(
          `Expected text "${input.expectedText}" not found in element. Got: "${actualText}"`
        );
      }
    } catch (textError) {
      errors.push(`Failed to verify text content: ${textError}`);
    }
  }

  // 4. If action is 'click' or 'fill', verify element is clickable/fillable
  if (input.action === 'click') {
    try {
      const isEnabled = await page.locator(output.locator).first().isEnabled();
      if (!isEnabled) {
        errors.push('Target element is not enabled (may be disabled or hidden)');
      }
    } catch (enableError) {
      errors.push(`Failed to check element enabled state: ${enableError}`);
    }
  }

  if (input.action === 'fill') {
    try {
      const isEditable = await page.locator(output.locator).first().isEditable();
      if (!isEditable) {
        errors.push('Target element is not editable');
      }
    } catch (editableError) {
      errors.push(`Failed to check element editable state: ${editableError}`);
    }
  }

  // Return result
  if (errors.length > 0) {
    return {
      status: 'fail',
      errors,
    };
  }

  return {
    status: 'pass',
    output,
  };
}

/**
 * Helper: Check if result passed validation
 */
export function isPassed(result: QualityGateResult): boolean {
  return result.status === 'pass';
}

/**
 * Helper: Get errors from failed result
 */
export function getErrors(result: QualityGateResult): string[] {
  return result.status === 'fail' ? result.errors : [];
}

/**
 * Helper: Get output from passed result
 */
export function getOutput(result: QualityGateResult): HealOutput | null {
  return result.status === 'pass' ? result.output : null;
}
