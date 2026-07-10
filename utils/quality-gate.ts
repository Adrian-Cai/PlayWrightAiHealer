/**
 * Quality Gate — AI 候选 Locator 使用前的风险门禁。
 *
 * 本文件的目标不是“尽量让自愈成功”，而是“避免错误自愈”。
 * AI 输出只能作为候选值，必须通过以下检查后才允许被 healer-core 用于重试原动作：
 * 1. 置信度不能低于阈值；
 * 2. Locator 必须合法，且必须唯一匹配 1 个元素；
 * 3. assert 场景如果有 expectedText，必须校验文本一致性；
 * 4. click/assert/locate 至少要求元素可见；
 * 5. click 要求 enabled；fill 要求 editable。
 *
 * 修改这里要保守。不要为了提高“自愈成功率”降低门槛，否则会增加点击错元素、断言错对象的风险。
 */

import { Page } from '@playwright/test';
import { HealInput, HealOutput, QualityGateResult } from '../skills/self-healing-locator/contract';

// 风险阈值：低于 0.6 的结果视为模型自己也不够确定，不能进入动作重试。
const CONFIDENCE_THRESHOLD = 0.6;

// 候选 Locator 必须唯一。匹配多个元素时，Playwright 可能点到错误对象，属于高风险误修复。
const MAX_MATCHING_ELEMENTS = 1;

/**
 * 校验 AI 生成的候选 Locator。
 *
 * 返回 discriminated union：
 * - pass：候选 Locator 可以用于本次动作重试；
 * - fail：候选 Locator 不可信，调用方应记录失败并继续抛错。
 */
export async function validateHeal(
  page: Page,
  input: HealInput,
  output: HealOutput
): Promise<QualityGateResult> {
  const errors: string[] = [];

  // 1. 模型置信度门禁。低置信度不直接 early return，是为了继续收集更多错误原因用于日志/飞书卡片展示。
  if (output.confidence < CONFIDENCE_THRESHOLD) {
    errors.push(
      `Confidence ${output.confidence} is below threshold ${CONFIDENCE_THRESHOLD}`
    );
  }

  // 2. 语法 + 唯一性校验。
  // 这里必须先做 count()，否则后续 text/isVisible/isEnabled 对 0 匹配元素可能产生等待或误导性错误。
  try {
    const locatorElements = await page.locator(output.locator).count();

    if (locatorElements === 0) {
      // 0 匹配没有继续检查的意义，直接失败，避免后续 actionability 检查悬挂。
      return {
        status: 'fail',
        errors: [`Locator matches 0 elements on page: ${output.locator}`],
      };
    } else if (locatorElements > MAX_MATCHING_ELEMENTS) {
      // 多匹配是高风险场景：即使元素可见，也不能证明它就是目标元素。
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

  // 3. assert 场景的文本一致性校验。
  // 只有当调用方提供 expectedText 时才检查，避免把无文本元素误判为失败。
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

  // 4. 可见性校验。
  // click/locate/assert 都至少要求目标元素在页面上可见；fill 单独走 editable 检查。
  if (input.action === 'click' || input.action === 'locate' || input.action === 'assert') {
    try {
      const isVisible = await page.locator(output.locator).first().isVisible();
      if (!isVisible) {
        errors.push('Target element is not visible');
      }
    } catch (visibleError) {
      errors.push(`Failed to check element visibility: ${visibleError}`);
    }
  }

  // 5. click 还必须确保元素 enabled，防止点击禁用按钮导致假通过或不稳定失败。
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

  // 6. fill 必须确保元素可编辑，避免把候选 Locator 指向不可输入的容器或展示节点。
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

/** 判断 QualityGateResult 是否通过。保留给测试和后续 reporter 展示逻辑使用。 */
export function isPassed(result: QualityGateResult): boolean {
  return result.status === 'pass';
}

/** 从失败结果中取错误列表；通过结果统一返回空数组，便于调用方少写分支。 */
export function getErrors(result: QualityGateResult): string[] {
  return result.status === 'fail' ? result.errors : [];
}

/** 从通过结果中取 HealOutput；失败时返回 null，避免调用方误用失败候选。 */
export function getOutput(result: QualityGateResult): HealOutput | null {
  return result.status === 'pass' ? result.output : null;
}
