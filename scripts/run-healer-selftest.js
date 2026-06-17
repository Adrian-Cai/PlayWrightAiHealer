#!/usr/bin/env node

/**
 * Self-test script for heal system
 * Runs tests with heal validation and restores git state on completion
 * Usage: node scripts/run-healer-selftest.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const cwd = process.cwd();
let hasError = false;

try {
  console.log('\n🔧 Healer Self-Test');
  console.log('====================\n');

  // Step 1: Stash uncommitted changes
  console.log('📝 Stashing uncommitted changes...');
  try {
    execSync('git stash', { cwd, stdio: 'pipe' });
    console.log('✓ Changes stashed\n');
  } catch (e) {
    // Might fail if nothing to stash, that's OK
    console.log('✓ No changes to stash\n');
  }

  // Step 2: Install dependencies
  console.log('📦 Installing dependencies...');
  execSync('npm ci', { cwd, stdio: 'inherit' });
  console.log('✓ Dependencies installed\n');

  // Step 3: Run unit tests
  console.log('🧪 Running unit tests...');
  try {
    execSync('npx playwright test tests/healer.spec.ts', { cwd, stdio: 'inherit' });
    console.log('✓ Unit tests passed\n');
  } catch (e) {
    console.warn('⚠️  Some unit tests failed\n');
    hasError = true;
  }

  // Step 4: Run main spec
  console.log('🎯 Running main spec (ai-case.spec.ts)...');
  try {
    execSync('npx playwright test tests/ai-case.spec.ts', { cwd, stdio: 'inherit' });
    console.log('✓ Main spec passed\n');
  } catch (e) {
    console.warn('⚠️  Main spec failed\n');
    hasError = true;
  }

  // Step 5: Run integration tests if enabled
  if (process.env.RUN_INTEGRATION) {
    console.log('🔗 Running integration tests...');
    try {
      execSync('RUN_INTEGRATION=1 npx playwright test tests/healer-integration.spec.ts', { cwd, stdio: 'inherit' });
      console.log('✓ Integration tests passed\n');
    } catch (e) {
      console.warn('⚠️  Integration tests failed\n');
      hasError = true;
    }
  }

  // Step 6: Check cache
  console.log('💾 Checking cache...');
  try {
    execSync('node scripts/print-cache.js', { cwd, stdio: 'inherit' });
  } catch (e) {
    // Might not have cache yet
  }

  console.log('\n✅ Self-test completed\n');
} catch (error) {
  hasError = true;
  console.error('\n❌ Error during self-test:', error.message, '\n');
} finally {
  // Step 7: Always restore git state
  console.log('📋 Restoring git state...');
  try {
    execSync('git stash pop', { cwd, stdio: 'pipe' });
    console.log('✓ Changes restored\n');
  } catch (e) {
    console.log('✓ No stashed changes to restore\n');
  }

  process.exit(hasError ? 1 : 0);
}
