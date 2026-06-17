#!/usr/bin/env node

/**
 * Debug helper to display healer-cache.json contents
 * Usage: node scripts/print-cache.js
 */

const fs = require('fs');
const path = require('path');

const cacheFile = path.resolve(__dirname, '..', 'healer-cache.json');

try {
  if (!fs.existsSync(cacheFile)) {
    console.log('Cache file not found:', cacheFile);
    process.exit(0);
  }

  const content = fs.readFileSync(cacheFile, 'utf-8');
  const cache = JSON.parse(content);

  console.log('\n📦 Healer Cache Contents');
  console.log('========================\n');

  if (!cache.entries || cache.entries.length === 0) {
    console.log('Cache is empty.\n');
    process.exit(0);
  }

  console.log(`Total entries: ${cache.entries.length}`);
  console.log(`Max size: ${cache.maxSize}`);
  console.log(`Default TTL: ${cache.defaultTtlMs}ms\n`);

  cache.entries.forEach((entry, index) => {
    console.log(`[${index + 1}] ${entry.key}`);
    console.log(`    Healed Locator: ${entry.value.locator}`);
    console.log(`    Strategy: ${entry.value.strategy}`);
    console.log(`    Confidence: ${(entry.value.confidence * 100).toFixed(1)}%`);
    console.log(`    Reason: ${entry.value.reason}`);
    console.log(`    Stored at: ${new Date(entry.timestamp).toISOString()}`);
    if (entry.expiresAt) {
      console.log(`    Expires at: ${new Date(entry.expiresAt).toISOString()}`);
    }
    console.log();
  });

  process.exit(0);
} catch (error) {
  console.error('Error reading cache file:', error.message);
  process.exit(1);
}
