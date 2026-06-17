/**
 * Healing Cache — LRU in-memory + persistent JSON file storage
 * Caches HealOutput by key (originalLocator + pageUrl)
 * Default TTL: 300 seconds
 */

import * as fs from 'fs';
import * as path from 'path';
import { CacheEntry, CacheStorage, HealOutput } from '../skills/self-healing-locator/contract';

const DEFAULT_TTL_MS = 300 * 1000; // 300 seconds
const CACHE_FILE = path.join(process.cwd(), 'healer-cache.json');
const MAX_CACHE_SIZE = 1000;

class HealCache {
  private cache: CacheStorage = {};
  private readonly ttlMs: number;
  private readonly cacheFile: string;

  constructor(ttlMs = DEFAULT_TTL_MS, cacheFile = CACHE_FILE) {
    this.ttlMs = ttlMs;
    this.cacheFile = cacheFile;
    this.loadFromDisk();
  }

  /**
   * Generate cache key from originalLocator + pageUrl
   */
  private getCacheKey(originalLocator: string, pageUrl: string): string {
    return `${originalLocator}|${pageUrl}`;
  }

  /**
   * Look up a cached HealOutput
   * Returns null if not found, expired, or invalid
   */
  get(originalLocator: string, pageUrl: string): HealOutput | null {
    const key = this.getCacheKey(originalLocator, pageUrl);
    const entry = this.cache[key];

    if (!entry) {
      return null;
    }

    // Check expiry
    if (Date.now() > entry.expiresAt) {
      delete this.cache[key];
      return null;
    }

    // Update usage stats
    entry.lastUsedAt = Date.now();
    entry.usageCount++;

    return entry.output;
  }

  /**
   * Store a HealOutput in cache
   */
  set(
    originalLocator: string,
    pageUrl: string,
    output: HealOutput,
    ttlMs = this.ttlMs
  ): void {
    const key = this.getCacheKey(originalLocator, pageUrl);
    const now = Date.now();

    this.cache[key] = {
      output,
      createdAt: now,
      expiresAt: now + ttlMs,
      lastUsedAt: now,
      usageCount: 1,
    };

    // Evict oldest entries if over size limit
    this.evictIfNeeded();

    // Persist to disk
    this.saveToDisk();
  }

  /**
   * Clear all cache
   */
  clear(): void {
    this.cache = {};
    this.saveToDisk();
  }

  /**
   * Get cache statistics
   */
  stats(): {
    size: number;
    entries: Array<{ key: string; entry: CacheEntry }>;
  } {
    const entries = Object.entries(this.cache).map(([key, entry]) => ({
      key,
      entry,
    }));
    return { size: entries.length, entries };
  }

  /**
   * Load cache from disk
   */
  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.cacheFile)) {
        return;
      }
      const data = fs.readFileSync(this.cacheFile, 'utf-8');
      this.cache = JSON.parse(data) as CacheStorage;
    } catch (error) {
      console.warn('[HealCache] Failed to load cache from disk:', error);
    }
  }

  /**
   * Save cache to disk
   */
  private saveToDisk(): void {
    try {
      fs.writeFileSync(this.cacheFile, JSON.stringify(this.cache, null, 2), 'utf-8');
    } catch (error) {
      console.error('[HealCache] Failed to save cache to disk:', error);
    }
  }

  /**
   * Evict least recently used entries if cache exceeds MAX_CACHE_SIZE
   */
  private evictIfNeeded(): void {
    const entries = Object.entries(this.cache);
    if (entries.length <= MAX_CACHE_SIZE) {
      return;
    }

    // Sort by lastUsedAt, evict oldest
    entries.sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);

    const toEvict = entries.length - MAX_CACHE_SIZE;
    for (let i = 0; i < toEvict; i++) {
      delete this.cache[entries[i][0]];
    }
  }
}

// Singleton instance
export const healCache = new HealCache();

export { HealCache };
