import { randomUUID } from 'crypto';
import { Page } from '@playwright/test';
import { HealEvent, HealInput, HealOutput } from '../skills/self-healing-locator/contract';

export interface HealResult {
  locator: string;
  output: HealOutput;
  cacheHit: boolean;
}

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

    const snapshot = await deps.capturePageState(page);
    await emit({ type: 'STATE_CAPTURED' });

    const inputWithSnapshot: HealInput = {
      ...input,
      domSnapshot: formatInteractiveElements(snapshot.interactiveElements),
    };

    const aiOutput = await deps.callAIForHeal(inputWithSnapshot);
    await emit({ type: 'AI_CALLED', output: aiOutput });

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
