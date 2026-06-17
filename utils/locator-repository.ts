/**
 * Locator Repository — Central read/write access to locator-store.json
 *
 * locator-store.json is the single source of truth for element locators.
 * Test specs reference locators by key (via aiClickByKey / aiAssertByKey / ...).
 * AI never edits test code; the Feishu callback server (Phase 3) only edits
 * this JSON file after a human approves a heal proposal.
 */

import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_STORE_PATH = path.resolve(process.cwd(), 'locator-store.json');

function getStorePath(): string {
  return process.env.LOCATOR_STORE_PATH || DEFAULT_STORE_PATH;
}

function readStore(): Record<string, string> {
  const file = getStorePath();
  if (!fs.existsSync(file)) {
    throw new Error(`locator-store.json not found: ${file}`);
  }
  const raw = fs.readFileSync(file, 'utf-8');
  const data = JSON.parse(raw);
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(`locator-store.json must be a JSON object: ${file}`);
  }
  return data as Record<string, string>;
}

function writeStore(data: Record<string, string>): void {
  const file = getStorePath();
  const dir = path.dirname(file);
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * Look up a locator by key. Throws if the key is missing.
 */
export function getLocator(locatorKey: string): string {
  const data = readStore();
  const locator = data[locatorKey];
  if (!locator || typeof locator !== 'string') {
    throw new Error(`Locator key not found in locator-store.json: ${locatorKey}`);
  }
  return locator;
}

/**
 * Update a locator by key. Throws if the key does not already exist
 * (prevents the callback server from silently introducing new keys).
 */
export function updateLocator(locatorKey: string, newLocator: string): void {
  if (!newLocator || typeof newLocator !== 'string') {
    throw new Error(`newLocator must be a non-empty string (key=${locatorKey})`);
  }
  const data = readStore();
  if (!(locatorKey in data)) {
    throw new Error(`Cannot update: locator key not found in locator-store.json: ${locatorKey}`);
  }
  data[locatorKey] = newLocator;
  writeStore(data);
}

/**
 * List all locator keys (for debugging / tooling).
 */
export function listLocatorKeys(): string[] {
  return Object.keys(readStore());
}

/**
 * Get the absolute path of the store file (for logging).
 */
export function getStoreFilePath(): string {
  return getStorePath();
}
