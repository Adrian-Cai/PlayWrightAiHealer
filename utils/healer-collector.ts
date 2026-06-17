/**
 * Healer Collector — JSONL event sink for test-run aggregation
 * Subscribes to HealEventBus and writes every event to test-results/ai-healer-events.jsonl
 * The Feishu Reporter reads this file in onEnd() to produce a single summary card
 */

import * as fs from 'fs';
import * as path from 'path';
import { healEventBus } from './heal-event-bus';
import { HealEvent } from '../skills/self-healing-locator/contract';

const resultDir = path.resolve(process.cwd(), 'test-results');
const eventFile = path.join(resultDir, 'ai-healer-events.jsonl');

let initialized = false;

function ensureDir(): void {
  if (!fs.existsSync(resultDir)) {
    fs.mkdirSync(resultDir, { recursive: true });
  }
}

/**
 * Initialize the collector and subscribe to all heal events.
 * Idempotent — safe to call multiple times.
 */
export function initHealerCollector(): void {
  if (initialized) return;
  initialized = true;

  ensureDir();

  healEventBus.on('all', (event: HealEvent) => {
    try {
      fs.appendFileSync(eventFile, JSON.stringify(event) + '\n', 'utf-8');
    } catch (err: any) {
      console.error('[HealerCollector] Failed to append event:', err.message);
    }
  });

  console.log(`[HealerCollector] Subscribed to heal events. Sink: ${eventFile}`);
}

/**
 * Clear the JSONL file. Call from globalSetup so each test run starts fresh.
 */
export function clearHealEvents(): void {
  ensureDir();
  fs.writeFileSync(eventFile, '', 'utf-8');
}

/**
 * Read all collected events from the JSONL file.
 */
export function readHealEvents(): HealEvent[] {
  if (!fs.existsSync(eventFile)) {
    return [];
  }

  const content = fs.readFileSync(eventFile, 'utf-8');
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as HealEvent);
}

/**
 * Get absolute path of the JSONL file (for debugging / artifact upload).
 */
export function getHealEventFile(): string {
  return eventFile;
}
