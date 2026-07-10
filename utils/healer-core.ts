import { randomUUID } from 'crypto';
import { Page } from '@playwright/test';
import { HealEvent, HealInput, HealOutput } from '../skills/self-healing-locator/contract';

/**
 * Healer Core
 *
 * AI 自愈的核心编排层，只处理“运行时救场”这条主链路：
 * 1. 为本次自愈生成事件 ID；
 * 2. 尝试读取运行内缓存；
 * 3. 缓存不可用时抓取页面状态；
 * 4. 调用 AI 生成候选 Locator；
 * 5. 通过 Quality Gate 校验候选结果；
 * 6. 使用候选 Locator 重试原动作；
 * 7. 通过事件总线向外发布过程事件。
 *
 * 边界要求：
 * - 本文件不能依赖飞书、Jenkins、CNB/GitHub PR、Reporter 等外围系统；
 * - 本文件不能把 AI 结果直接写回 locator-store.json；
 * - 正式 Locator 的沉淀必须由 ai-healer.ts 记录 Proposal，再经过人工审核链路处理。
 */

export interface HealResult {
  /** 最终被使用的候选 Locator。 */
  locator: string;
  /** AI 或缓存返回的完整候选结果，包含 strategy/confidence/reason。 */
  output: HealOutput;
  /** 是否来自运行内缓存。缓存命中后仍然必须重新校验。 */
  cacheHit: boolean;
}

/**
 * 核心编排依赖全部通过接口注入，避免 healer-core 直接绑定具体实现。
 * 这样单测可以替换 AI、缓存、DOM 抓取和事件发送逻辑，也能保证核心层不反向依赖外围集成。
 */
export interface HealerCoreDependencies {
  getCached(originalLocator: string, pageUrl: string): HealOutput | null;
  setCached(originalLocator: string, pageUrl: string, output: HealOutput): void;
  capturePageState(page: Page): Promise<{
    interactiveElements: Array<{
      tag: string;
      text?: string;
      classes?: string;
      id?: string;
      placeholder?: string | null;
      type?: string | null;
      role?: string;
    }>;
  }>;
  callAIForHeal(input: HealInput): Promise<HealOutput>;
  validateHeal(
    page: Page,
    input: HealInput,
    output: HealOutput
  ): Promise<
    | { status: 'pass'; output: HealOutput }
    | { status: 'fail'; errors: string[] }
  >;
  emit(event: Omit<HealEvent, 'testName' | 'jenkinsUrl'>): Promise<void>;
}

export interface HealerCoreOptions {
  /**
   * 原动作重试钩子，由 ai-healer.ts 传入。
   * core 只知道“用这个 Locator 重试”，不关心具体是 click/assert/fill/locate。
   */
  useLocator?: (locator: string) => Promise<void>;
}

export async function healLocator(
  page: Page,
  input: HealInput,
  deps: HealerCoreDependencies,
  options: HealerCoreOptions = {}
): Promise<HealResult> {
  const startTime = Date.now();
  const eventId = randomUUID();

  // 所有自愈事件共享同一个 eventId，便于 reporter/日志把一条自愈链路串起来。
  const emit = (event: Omit<HealEvent, 'testName' | 'jenkinsUrl' | 'id' | 'timestamp' | 'input' | 'retryCount' | 'durationMs' | 'cacheHit'> & Partial<Pick<HealEvent, 'cacheHit'>>) =>
    deps.emit({
      id: eventId,
      timestamp: new Date().toISOString(),
      input,
      retryCount: 0,
      durationMs: Date.now() - startTime,
      cacheHit: event.cacheHit ?? false,
      ...event,
    });

  await emit({ type: 'HEAL_START', durationMs: 0 });

  try {
    // 1. 先查运行内缓存，避免同一轮测试中同一个失效 Locator 反复调用 AI。
    // 注意：缓存只提升效率，不代表可信；命中后仍必须经过 Quality Gate。
    const cachedOutput = deps.getCached(input.originalLocator, input.pageUrl);
    if (cachedOutput) {
      await emit({
        type: 'CACHE_HIT',
        output: cachedOutput,
        cacheHit: true,
        finalLocator: cachedOutput.locator,
      });

      const cachedResult = await tryValidatedLocator(
        page,
        input,
        cachedOutput,
        true,
        deps,
        emit,
        options.useLocator
      );
      if (cachedResult) return cachedResult;
    }

    // 2. 缓存不可用或缓存校验失败时，抓取当前页面可交互元素作为 AI 上下文。
    // 这里不传全量 DOM，避免 token 膨胀，也减少把无关节点交给模型的噪音。
    const snapshot = await deps.capturePageState(page);
    await emit({ type: 'STATE_CAPTURED' });

    const inputWithSnapshot: HealInput = {
      ...input,
      domSnapshot: formatInteractiveElements(snapshot.interactiveElements),
    };

    // 3. AI 只生成候选 Locator。候选结果不能直接使用，也不能在这里持久化。
    const aiOutput = await deps.callAIForHeal(inputWithSnapshot);
    await emit({ type: 'AI_CALLED', output: aiOutput });

    // 4. 候选 Locator 通过 Quality Gate 后，才允许重试原动作。
    const result = await tryValidatedLocator(
      page,
      input,
      aiOutput,
      false,
      deps,
      emit,
      options.useLocator
    );

    if (!result) {
      throw new Error('AI locator did not pass validation');
    }

    // 5. 只有“通过校验并成功重试”的候选结果才写入运行内缓存。
    // globalSetup 会跨运行清空缓存，防止绕过人工审核。
    deps.setCached(input.originalLocator, input.pageUrl, aiOutput);
    return result;
  } catch (error) {
    await emit({
      type: 'HEAL_FAILED',
      error: String(error),
    });
    throw error;
  }
}

async function tryValidatedLocator(
  page: Page,
  input: HealInput,
  output: HealOutput,
  cacheHit: boolean,
  deps: HealerCoreDependencies,
  emit: (event: Omit<HealEvent, 'testName' | 'jenkinsUrl' | 'id' | 'timestamp' | 'input' | 'retryCount' | 'durationMs' | 'cacheHit'> & Partial<Pick<HealEvent, 'cacheHit'>>) => Promise<void>,
  useLocator?: (locator: string) => Promise<void>
): Promise<HealResult | null> {
  // Quality Gate 是防误修复的最后一道门：置信度、唯一性、可见性、可操作性都在这里处理。
  const validationResult = await deps.validateHeal(page, input, output);
  if (validationResult.status === 'fail') {
    await emit({
      type: 'VALIDATION_FAILED',
      output,
      validation: { valid: false, errors: validationResult.errors },
      error: validationResult.errors.join('; '),
      cacheHit,
    });
    return null;
  }

  await emit({
    type: 'VALIDATION_PASSED',
    output,
    validation: { valid: true, errors: [] },
    cacheHit,
  });

  // 通过校验后才执行原动作重试；失败会被外层 catch 捕获并记录 HEAL_FAILED。
  if (useLocator) {
    await useLocator(output.locator);
  }

  await emit({
    type: 'HEAL_SUCCESS',
    output,
    cacheHit,
    finalLocator: output.locator,
  });

  return { locator: output.locator, output, cacheHit };
}

/**
 * 将页面可交互元素压缩成模型可读的文本列表。
 * 只保留 tag/id/class/text/placeholder/role 等定位器生成所需信息，避免把大段 DOM 原样塞给模型。
 */
function formatInteractiveElements(
  elements: HealerCoreDependencies['capturePageState'] extends (page: Page) => Promise<infer T>
    ? T extends { interactiveElements: infer U }
      ? U
      : never
    : never
): string {
  return elements
    .map((el) => {
      const parts = [el.tag];
      if (el.id) parts.push(`#${el.id}`);
      if (el.classes) parts.push(`.${el.classes.split(' ').join('.')}`);
      if (el.text) parts.push(`text="${el.text}"`);
      if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
      if (el.role) parts.push(`role="${el.role}"`);
      return parts.join(' ');
    })
    .join('\n');
}
