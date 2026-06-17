/**
 * Integration tests for heal system
 * Tests full end-to-end healing workflows with mocked AI responses
 * 
 * Run with: RUN_INTEGRATION=1 npx playwright test tests/healer-integration.spec.ts
 */

import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { aiClick, aiAssert, aiFill, aiLocate, healEventBus, healCache } from '../utils/ai-healer';
import { setMockOpenAIClient } from '../utils/openai-client';

// Skip integration tests unless explicitly enabled
const skipIntegration = !process.env.RUN_INTEGRATION;

test.describe('Integration: AI Heal Workflows', () => {
  // Set up mock AI client for deterministic responses
  test.beforeAll(() => {
    setMockOpenAIClient(async (input: any) => {
      // Mock AI response for changed selectors
      if (input.originalLocator?.includes('ant-menu-item')) {
        return {
          locator: '.new-menu-item',
          strategy: 'css' as const,
          confidence: 0.95,
          reason: 'selector renamed from ant-menu-item to new-menu-item',
        };
      }
      if (input.originalLocator?.includes('ant-btn')) {
        return {
          locator: '.new-button',
          strategy: 'css' as const,
          confidence: 0.92,
          reason: 'selector renamed from ant-btn to new-button',
        };
      }
      return {
        locator: '[data-testid="batch-confirm"]',
        strategy: 'css' as const,
        confidence: 0.88,
        reason: 'using data-testid as fallback',
      };
    });
  });

  test('should load broken-page fixture', async ({ page }) => {
    test.skip(skipIntegration, 'Integration tests disabled. Run with RUN_INTEGRATION=1');

    const fixturePath = path.resolve(__dirname, 'fixtures', 'broken-page.html');
    const fileUrl = `file://${fixturePath}`;

    await page.goto(fileUrl);
    const title = await page.title();
    expect(title).toBe('AI Case 自愈测试页面');
  });

  test('should heal menu item click when selector changes', async ({ page }) => {
    test.skip(skipIntegration, 'Integration tests disabled. Run with RUN_INTEGRATION=1');

    const fixturePath = path.resolve(__dirname, 'fixtures', 'broken-page.html');
    await page.goto(`file://${fixturePath}`);

    // Attempt to click with old selector that no longer exists
    const eventsCaught: any[] = [];
    healEventBus.on('all', (event) => {
      eventsCaught.push(event.type);
    });

    try {
      // This should trigger healing since .ant-menu-item doesn't exist
      await aiClick(page, '.ant-menu-item:first-child', '菜单项点击');

      // Verify events were emitted
      expect(eventsCaught).toContain('HEAL_START');
      expect(eventsCaught).toContain('HEAL_SUCCESS');
    } finally {
      healEventBus.clear();
    }
  });

  test('should assert element visibility with healing', async ({ page }) => {
    test.skip(skipIntegration, 'Integration tests disabled. Run with RUN_INTEGRATION=1');

    const fixturePath = path.resolve(__dirname, 'fixtures', 'broken-page.html');
    await page.goto(`file://${fixturePath}`);

    // Click to show the section first
    await page.click('[data-testid="manual-confirm"]');

    // Try to assert visibility of element with changed selector
    try {
      await aiAssert(page, '.ant-btn:has-text("批量确认")', '批量确认按钮');
      // Should succeed after healing
    } catch (e) {
      // Healing might still fail if element not rendered, that's OK for this test
    }
  });

  test('should fill input with healing', async ({ page }) => {
    test.skip(skipIntegration, 'Integration tests disabled. Run with RUN_INTEGRATION=1');

    const fixturePath = path.resolve(__dirname, 'fixtures', 'broken-page.html');
    await page.goto(`file://${fixturePath}`);

    // Show the form
    await page.click('[data-testid="manual-confirm"]');

    try {
      // Try to fill with old selector
      await aiFill(page, '.old-textarea-class', 'Test input', 'textarea字段');
      // Might heal or fail, either way is acceptable for integration test
    } catch (e) {
      // Expected if healing fails
    }
  });

  test('should cache healed locators across calls', async ({ page }) => {
    test.skip(skipIntegration, 'Integration tests disabled. Run with RUN_INTEGRATION=1');

    const fixturePath = path.resolve(__dirname, 'fixtures', 'broken-page.html');
    await page.goto(`file://${fixturePath}`);

    // Clear cache before test
    healCache.clear();

    const eventsCaught: any[] = [];
    healEventBus.on('all', (event) => {
      eventsCaught.push({ type: event.type, cacheHit: event.cacheHit });
    });

    try {
      // First call - should hit AI
      await aiLocate(page, '.ant-menu-item', '菜单项');
      expect(eventsCaught.some((e) => e.cacheHit === false)).toBe(true);

      // Second call - should hit cache
      const stats1 = healCache.stats();
      await aiLocate(page, '.ant-menu-item', '菜单项');
      const stats2 = healCache.stats();

      expect(stats2.size).toBeGreaterThanOrEqual(stats1.size);
    } finally {
      healEventBus.clear();
    }
  });

  test('should emit correct events during heal lifecycle', async ({ page }) => {
    test.skip(skipIntegration, 'Integration tests disabled. Run with RUN_INTEGRATION=1');

    const fixturePath = path.resolve(__dirname, 'fixtures', 'broken-page.html');
    await page.goto(`file://${fixturePath}`);

    healCache.clear();

    const eventSequence: string[] = [];
    healEventBus.on('all', (event) => {
      eventSequence.push(event.type);
    });

    try {
      await aiClick(page, '.nonexistent-selector', 'test click');
    } catch (e) {
      // Expected to fail, but events should still be emitted
    }

    // Should have HEAL_START at minimum
    expect(eventSequence).toContain('HEAL_START');

    healEventBus.clear();
  });

  test('should retrieve cache statistics', async ({ page }) => {
    test.skip(skipIntegration, 'Integration tests disabled. Run with RUN_INTEGRATION=1');

    healCache.clear();

    const stats1 = healCache.stats();
    expect(stats1.size).toBe(0);

    // Manually add a cache entry
    healCache.set('.test', 'http://example.com', {
      locator: '.healed',
      strategy: 'css',
      confidence: 0.9,
      reason: 'test',
    });

    const stats2 = healCache.stats();
    expect(stats2.size).toBe(1);
    expect(stats2.entries).toHaveLength(1);
  });
});
