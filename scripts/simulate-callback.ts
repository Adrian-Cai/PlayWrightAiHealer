#!/usr/bin/env tsx
/**
 * Local simulation of a Feishu card-action callback.
 *
 * Lets you verify the approve/reject → locator-store.json update loop WITHOUT
 * real Feishu credentials or the WebSocket long-connection. Useful for:
 *   - Confirming Phase 3 logic works end-to-end before wiring real Feishu
 *   - Debugging proposal/locator-store state after a test run
 *
 * Prerequisites: a test run has already produced pending proposals in
 *   test-results/healer-proposals.json (run a test with a deliberately broken
 *   locator first).
 *
 * Usage:
 *   tsx scripts/simulate-callback.ts                     # list pending proposals
 *   tsx scripts/simulate-callback.ts approve <proposalId>
 *   tsx scripts/simulate-callback.ts reject  <proposalId>
 */

import { readProposals } from '../utils/healer-proposal-store';
import { handleReviewCallback } from '../utils/healer-review-actions';

const [, , cmd, proposalId] = process.argv;

function listPending() {
  const proposals = readProposals();
  const pending = proposals.filter((p) => p.status === 'pending');

  if (proposals.length === 0) {
    console.log('No proposals found. Run a test with a broken locator first to generate one.');
    console.log('  HEALER_MOCK_RESPONSE=\'{...}\' npx playwright test tests/ai-case.spec.ts');
    return;
  }

  console.log(`Total proposals: ${proposals.length} (pending: ${pending.length})\n`);

  if (pending.length === 0) {
    console.log('No pending proposals to review. All are terminal (approved/rejected/failed).');
    proposals.slice(0, 10).forEach((p, i) => {
      console.log(`  ${i + 1}. [${p.status}] ${p.locatorKey} — ${p.elementName}`);
    });
    return;
  }

  console.log('Pending proposals (copy an id to approve/reject):');
  pending.forEach((p, i) => {
    console.log(`\n  ${i + 1}. id: ${p.id}`);
    console.log(`     key: ${p.locatorKey}  element: ${p.elementName}  action: ${p.action}`);
    console.log(`     old:  ${p.oldLocator}`);
    console.log(`     new:  ${p.newLocator}`);
    console.log(`     conf: ${p.confidence}  reason: ${p.reason}`);
    console.log(`     test: ${p.testName || '-'}`);
    console.log(`\n     → tsx scripts/simulate-callback.ts approve ${p.id}`);
  });
}

function act(action: 'approve_locator' | 'reject_locator', id: string) {
  const outcome = handleReviewCallback({ action, proposalId: id });
  if (outcome.ok) {
    console.log(`✓ SUCCESS: ${outcome.message}`);
    console.log(`  Proposal ${id} is now '${outcome.proposal.status}'.`);
    if (action === 'approve_locator') {
      console.log('  locator-store.json has been updated. Next test run will use the new locator.');
    }
  } else {
    console.error(`✗ FAILED: ${outcome.error}`);
    process.exit(1);
  }
}

switch (cmd) {
  case undefined:
  case 'list':
    listPending();
    break;
  case 'approve':
    if (!proposalId) {
      console.error('Usage: tsx scripts/simulate-callback.ts approve <proposalId>');
      process.exit(1);
    }
    act('approve_locator', proposalId);
    break;
  case 'reject':
    if (!proposalId) {
      console.error('Usage: tsx scripts/simulate-callback.ts reject <proposalId>');
      process.exit(1);
    }
    act('reject_locator', proposalId);
    break;
  default:
    console.error(`Unknown command: ${cmd}`);
    console.error('Usage: tsx scripts/simulate-callback.ts [list|approve <id>|reject <id>]');
    process.exit(1);
}
