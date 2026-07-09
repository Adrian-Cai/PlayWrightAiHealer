import { test, expect } from '@playwright/test';
import { aiAssert, aiClick, aiLocate, healCache, healEventBus } from '../utils/ai-healer';
import { setMockOpenAIClient } from '../utils/openai-client';

test.beforeEach(() => {
  healCache.clear();
  healEventBus.clear();
});

test.afterEach(() => {
  setMockOpenAIClient(null);
  healEventBus.clear();
  healCache.clear();
});

test('aiAssert heals when the original locator is missing instead of returning on false visibility', async ({ page }) => {
  let aiCalls = 0;
  const events: string[] = [];

  setMockOpenAIClient(async () => {
    aiCalls++;
    return {
      locator: '#healed',
      strategy: 'css',
      confidence: 0.95,
      reason: 'missing original selector replaced by stable id',
    };
  });
  healEventBus.on('all', (event) => events.push(event.type));

  await page.setContent('<button id="healed">Ready</button>');

  await aiAssert(page, '#missing', 'ready button', undefined, { timeout: 100 });

  expect(aiCalls).toBe(1);
  expect(events).toContain('HEAL_START');
  expect(events).toContain('HEAL_SUCCESS');
});

test('aiAssert heals when expected text does not match the original locator', async ({ page }) => {
  let aiCalls = 0;

  setMockOpenAIClient(async (input) => {
    aiCalls++;
    expect(input.errorMessage).toContain('Expected');
    return {
      locator: '#healed',
      strategy: 'css',
      confidence: 0.95,
      reason: 'visible element text changed',
    };
  });

  await page.setContent(`
    <button id="old">Wrong</button>
    <button id="healed">Expected</button>
  `);

  await aiAssert(page, '#old', 'expected button', undefined, {
    timeout: 100,
    expectedText: 'Expected',
  });

  expect(aiCalls).toBe(1);
});

test('aiLocate heals when the original locator matches more than one visible element', async ({ page }) => {
  setMockOpenAIClient(async () => ({
    locator: '#healed',
    strategy: 'css',
    confidence: 0.95,
    reason: 'ambiguous locator replaced by unique id',
  }));

  await page.setContent(`
    <button class="item">One</button>
    <button class="item">Two</button>
    <button id="healed">Only</button>
  `);

  await expect(aiLocate(page, '.item', 'unique item', undefined, { timeout: 100 }))
    .resolves.toBe('#healed');
});

test('cached locators are revalidated and stale cache falls back to AI', async ({ page }) => {
  let aiCalls = 0;

  setMockOpenAIClient(async () => {
    aiCalls++;
    return {
      locator: '#healed',
      strategy: 'css',
      confidence: 0.95,
      reason: 'stale cached locator no longer exists',
    };
  });

  await page.setContent('<button id="healed">Click me</button>');
  healCache.set('#missing', page.url(), {
    locator: '#stale-cache',
    strategy: 'css',
    confidence: 0.95,
    reason: 'old cache entry',
  });

  await aiClick(page, '#missing', 'click target', undefined, { timeout: 100 });

  expect(aiCalls).toBe(1);
});
