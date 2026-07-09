/**
 * Unit tests for heal system components
 * Tests: cache, event bus, quality gate validation
 */

import { test, expect } from '@playwright/test';
import * as os from 'os';
import * as path from 'path';
import { HealCache } from '../utils/heal-cache';
import { HealEventBus } from '../utils/heal-event-bus';
import { HealOutput } from '../skills/self-healing-locator/contract';

test.describe('HealEventBus', () => {
  test('should emit and receive events', async () => {
    const bus = new HealEventBus();
    const received: string[] = [];

    bus.on('TEST_EVENT', (event) => {
      received.push(event.id);
    });

    const testEvent = {
      id: 'test-1',
      type: 'HEAL_START' as const,
      timestamp: new Date().toISOString(),
      input: {
        originalLocator: '.btn',
        description: 'button',
        pageUrl: 'http://example.com',
        action: 'click' as const,
      },
      retryCount: 0,
      durationMs: 100,
      cacheHit: false,
    };

    // Rename to TEST_EVENT for this test
    const renamedEvent = { ...testEvent, type: 'TEST_EVENT' as any };
    await bus.emit(renamedEvent);

    expect(received).toContain('test-1');
  });

  test('should support wildcard subscriptions', async () => {
    const bus = new HealEventBus();
    const received: any[] = [];

    bus.on('all', (event) => {
      received.push(event.type);
    });

    const event1 = {
      id: 'test-1',
      type: 'HEAL_START' as const,
      timestamp: new Date().toISOString(),
      input: {
        originalLocator: '.btn',
        description: 'button',
        pageUrl: 'http://example.com',
        action: 'click' as const,
      },
      retryCount: 0,
      durationMs: 100,
      cacheHit: false,
    };

    await bus.emit(event1);
    expect(received).toContain('HEAL_START');
  });

  test('should handle unsubscription', async () => {
    const bus = new HealEventBus();
    const received: string[] = [];

    const handler = (event: any) => received.push(event.id);
    bus.on('TEST', handler);
    bus.off('TEST', handler);

    const event = {
      id: 'test-1',
      type: 'TEST' as any,
      timestamp: new Date().toISOString(),
      input: {
        originalLocator: '.btn',
        description: 'button',
        pageUrl: 'http://example.com',
        action: 'click' as const,
      },
      retryCount: 0,
      durationMs: 100,
      cacheHit: false,
    };

    await bus.emit(event);
    expect(received).toHaveLength(0);
  });
});

test.describe('HealCache', () => {
  test('should store and retrieve cached outputs', async () => {
    const cacheFile = path.join(os.tmpdir(), `heal-cache-${Date.now()}.json`);
    const cache = new HealCache(300000, cacheFile); // Use 300s TTL and an isolated temp file

    const output: HealOutput = {
      locator: 'button:has-text("OK")',
      strategy: 'css',
      confidence: 0.95,
      reason: 'element found by text',
    };

    cache.set('.old-class', 'http://example.com', output);
    const retrieved = cache.get('.old-class', 'http://example.com');

    expect(retrieved).toBeDefined();
    expect(retrieved?.locator).toBe('button:has-text("OK")');
    expect(retrieved?.confidence).toBe(0.95);
  });

  test('should return null for non-existent keys', async () => {
    const cache = new HealCache();
    const retrieved = cache.get('.nonexistent', 'http://example.com');
    expect(retrieved).toBeNull();
  });

  test('should track cache statistics', async () => {
    const cache = new HealCache();

    const output: HealOutput = {
      locator: 'button',
      strategy: 'css',
      confidence: 0.8,
      reason: 'test',
    };

    cache.set('.btn1', 'http://example.com', output);
    cache.set('.btn2', 'http://example.com', output);

    const stats = cache.stats();
    expect(stats.size).toBe(2);
  });

  test('should clear all cache entries', async () => {
    const cache = new HealCache();

    const output: HealOutput = {
      locator: 'button',
      strategy: 'css',
      confidence: 0.8,
      reason: 'test',
    };

    cache.set('.btn', 'http://example.com', output);
    cache.clear();

    const retrieved = cache.get('.btn', 'http://example.com');
    expect(retrieved).toBeNull();
  });
});
