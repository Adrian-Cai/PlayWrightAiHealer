/**
 * Healer Proposal Store — Persistent "pending review" proposals
 *
 * When AI healing succeeds, a proposal (oldLocator → newLocator) is recorded.
 * When AI healing fails, a 'failed' proposal is recorded for audit.
 *
 * The Feishu Reporter reads pending proposals in onEnd() and sends an
 * interactive review card. Phase 3 adds approve/reject buttons + a callback
 * server that calls updateProposalStatus().
 *
 * Storage: test-results/healer-proposals.json (gitignored via test-results/)
 * Lifecycle: cleared in globalSetup so each run starts fresh.
 *
 * Dedupe: addProposal() with the same (locatorKey + oldLocator + newLocator)
 * as an existing 'pending' proposal returns the existing one instead of
 * creating a duplicate. This prevents N cases failing on the same locator
 * from producing N identical review cards.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export type HealProposalStatus = 'pending' | 'approved' | 'rejected' | 'failed';

export type HealProposalAction = 'click' | 'assert' | 'fill' | 'locate';

export interface HealProposal {
  /** UUID */
  id: string;
  /** ISO 8601 timestamp */
  createdAt: string;
  /** pending = AI healed successfully, awaiting human review */
  status: HealProposalStatus;
  /** Run identifier (process.env.RUN_ID) for cross-referencing events */
  runId?: string;
  /** Test case title (from TestInfo) */
  testName?: string;
  /** Test file path (from TestInfo) */
  testFile?: string;
  /** Page URL where the heal happened */
  pageUrl?: string;
  /** Key in locator-store.json */
  locatorKey: string;
  /** Human description of the element */
  elementName: string;
  /** Action that triggered the heal */
  action: HealProposalAction;
  /** The original (failing) locator */
  oldLocator: string;
  /** The AI-suggested new locator (present when status === 'pending') */
  newLocator?: string;
  /** AI confidence 0.0–1.0 */
  confidence?: number;
  /** AI reason for the new locator */
  reason?: string;
  /** Error detail (present when status === 'failed') */
  errorDetail?: string;
}

const DEFAULT_PROPOSAL_DIR = path.resolve(process.cwd(), 'test-results');
const DEFAULT_PROPOSAL_FILE = path.join(DEFAULT_PROPOSAL_DIR, 'healer-proposals.json');

function getProposalFile(): string {
  return process.env.HEALER_PROPOSAL_PATH || DEFAULT_PROPOSAL_FILE;
}

function ensureDir(file: string): void {
  const dir = path.dirname(file);
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Wipe the proposals file. Called from globalSetup so each run starts fresh.
 */
export function clearProposals(): void {
  const file = getProposalFile();
  ensureDir(file);
  fs.writeFileSync(file, '[]', 'utf-8');
}

/**
 * Read all proposals from disk.
 */
export function readProposals(): HealProposal[] {
  const file = getProposalFile();
  if (!fs.existsSync(file)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(file, 'utf-8').trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HealProposal[]) : [];
  } catch (err) {
    console.warn('[healer-proposal-store] failed to read proposals:', err);
    return [];
  }
}

function persist(proposals: HealProposal[]): void {
  const file = getProposalFile();
  ensureDir(file);
  fs.writeFileSync(file, JSON.stringify(proposals, null, 2), 'utf-8');
}

/**
 * Add a proposal. If a 'pending' proposal with the same
 * (locatorKey + oldLocator + newLocator) already exists, return it instead
 * of creating a duplicate.
 *
 * Status is derived: 'pending' if newLocator is present, else 'failed'.
 */
export function addProposal(
  proposal: Omit<HealProposal, 'id' | 'createdAt' | 'status'>
): HealProposal {
  const proposals = readProposals();

  const hasNewLocator = Boolean(proposal.newLocator);

  // Dedupe pending proposals by content identity
  if (hasNewLocator) {
    const existing = proposals.find(
      (p) =>
        p.status === 'pending' &&
        p.locatorKey === proposal.locatorKey &&
        p.oldLocator === proposal.oldLocator &&
        p.newLocator === proposal.newLocator
    );
    if (existing) {
      return existing;
    }
  }

  const full: HealProposal = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    status: hasNewLocator ? 'pending' : 'failed',
    ...proposal,
  };

  proposals.push(full);
  persist(proposals);
  return full;
}

/**
 * Update a proposal's status (approve / reject). Throws if not found.
 * Cannot transition a non-pending proposal (idempotent guard).
 */
export function updateProposalStatus(
  proposalId: string,
  status: 'approved' | 'rejected'
): HealProposal {
  const proposals = readProposals();
  const target = proposals.find((p) => p.id === proposalId);
  if (!target) {
    throw new Error(`Proposal not found: ${proposalId}`);
  }
  if (target.status !== 'pending') {
    // Idempotent: return as-is if already in a terminal state
    return target;
  }
  target.status = status;
  persist(proposals);
  return target;
}

/**
 * Get the absolute path of the proposals file (for logging/debugging).
 */
export function getProposalFilePath(): string {
  return getProposalFile();
}
