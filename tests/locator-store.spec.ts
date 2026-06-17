/**
 * Unit tests for locator-repository.ts
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import {
  getLocator,
  updateLocator,
  listLocatorKeys,
  getStoreFilePath,
} from '../utils/locator-repository';

const TMP_STORE = path.join(__dirname, '.tmp-locator-store.spec.json');

test.beforeEach(() => {
  if (fs.existsSync(TMP_STORE)) fs.unlinkSync(TMP_STORE);
  // Seed a minimal store
  fs.writeFileSync(
    TMP_STORE,
    JSON.stringify(
      {
        okButton: 'button:has-text("OK")',
        cancelButton: 'button:has-text("Cancel")',
      },
      null,
      2
    ),
    'utf-8'
  );
  process.env.LOCATOR_STORE_PATH = TMP_STORE;
});

test.afterEach(() => {
  delete process.env.LOCATOR_STORE_PATH;
  if (fs.existsSync(TMP_STORE)) fs.unlinkSync(TMP_STORE);
});

test('getLocator returns the locator string for an existing key', () => {
  expect(getLocator('okButton')).toBe('button:has-text("OK")');
});

test('getLocator throws for a missing key', () => {
  expect(() => getLocator('doesNotExist')).toThrow(/Locator key not found/);
});

test('listLocatorKeys returns all keys', () => {
  const keys = listLocatorKeys();
  expect(keys.sort()).toEqual(['cancelButton', 'okButton']);
});

test('updateLocator writes back a new value for an existing key', () => {
  updateLocator('okButton', '[role="button"]:has-text("OK")');
  // Re-read via the API to confirm persistence
  expect(getLocator('okButton')).toBe('[role="button"]:has-text("OK")');
  // Confirm it actually hit the file on disk
  const raw = JSON.parse(fs.readFileSync(TMP_STORE, 'utf-8'));
  expect(raw.okButton).toBe('[role="button"]:has-text("OK")');
});

test('updateLocator throws when key does not exist (no silent new keys)', () => {
  expect(() => updateLocator('brandNewKey', 'button')).toThrow(/Cannot update/);
});

test('updateLocator throws on empty newLocator', () => {
  expect(() => updateLocator('okButton', '')).toThrow(/non-empty string/);
});

test('LOCATOR_STORE_PATH override points to the temp file', () => {
  expect(getStoreFilePath()).toBe(TMP_STORE);
});

test('getLocator throws with a helpful message when store file is missing', () => {
  delete process.env.LOCATOR_STORE_PATH;
  const missing = path.join(__dirname, '.tmp-does-not-exist.json');
  process.env.LOCATOR_STORE_PATH = missing;
  expect(() => getLocator('anyKey')).toThrow(/locator-store.json not found/);
});
