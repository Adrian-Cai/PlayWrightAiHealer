/**
 * CNB PR Creator (Phase 4)
 *
 * After a human approves a heal proposal via the Feishu card, this module
 * creates a Git branch, commits the updated locator-store.json, pushes to
 * CNB, and opens a Pull Request — so the locator change goes through code
 * review instead of silently mutating the main branch.
 *
 * Flow:
 *   1. git checkout -b ai-heal/{locatorKey}-{timestamp}
 *   2. (locator-store.json already updated by approveLocatorProposal)
 *   3. git add locator-store.json && git commit
 *   4. git push origin HEAD
 *   5. POST https://api.cnb.cool/{repo}/-/pulls  →  get PR web_url
 *   6. git checkout {originalBranch}  (restore working tree)
 *
 * The caller (feishu-callback-server.js) should run this AFTER
 * approveLocatorProposal() has already written the new locator to
 * locator-store.json on disk.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import axios from 'axios';
import { HealProposal } from './healer-proposal-store';

export interface CreatePRResult {
  ok: boolean;
  prUrl?: string;
  branch?: string;
  error?: string;
}

/**
 * Resolve the git repo root from the current working directory.
 */
function getRepoRoot(): string {
  return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
}

/**
 * Run a git command in the repo root, returning trimmed stdout.
 * Throws on non-zero exit (caller should catch).
 */
function git(args: string, repoRoot?: string): string {
  const cwd = repoRoot || getRepoRoot();
  return execSync(`git -C ${cwd} ${args}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

/**
 * Extract {group}/{repo} from the origin remote URL.
 * e.g. https://cnb.cool/ImAcaiy/playwright-ai-healer.git → ImAcaiy/playwright-ai-healer
 */
function getRepoPath(): string {
  const remote = git('remote get-url origin');
  // Handle https://cnb.cool/{group}/{repo}.git
  const match = remote.match(/cnb\.cool[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (!match) {
    throw new Error(`Cannot parse repo path from remote: ${remote}`);
  }
  return match[1];
}

/**
 * Sanitize a locator key into a valid git branch name component.
 */
function sanitizeBranchName(key: string): string {
  return key.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
}

/**
 * Create a PR on CNB via REST API.
 * Returns the PR web URL.
 */
async function createCNBPullRequest(
  repoPath: string,
  title: string,
  headBranch: string,
  baseBranch: string,
  body: string
): Promise<string> {
  const token = process.env.CNB_TOKEN;
  if (!token) {
    throw new Error('CNB_TOKEN environment variable is not set');
  }

  const url = `https://api.cnb.cool/${repoPath}/-/pulls`;
  const resp = await axios.post(
    url,
    {
      title,
      head: headBranch,
      base: baseBranch,
      body,
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    }
  );

  // CNB returns the PR object; web_url is the human-visible link
  const prUrl = resp.data?.web_url || resp.data?.html_url;
  if (!prUrl) {
    // Fallback: construct URL from repo path + PR number
    const prNumber = resp.data?.number || resp.data?.id;
    if (prNumber) {
      return `https://cnb.cool/${repoPath}/-/pulls/${prNumber}`;
    }
    throw new Error(`CNB API response missing PR URL: ${JSON.stringify(resp.data)}`);
  }
  return prUrl;
}

/**
 * Full Phase 4 flow: branch → commit → push → create PR.
 *
 * @param proposal  The approved heal proposal (carries oldLocator/newLocator)
 * @returns         PR URL on success, or error message on failure
 */
export async function createHealPR(proposal: HealProposal): Promise<CreatePRResult> {
  const repoRoot = getRepoRoot();
  let originalBranch = '';

  try {
    // 1. Remember current branch (to restore later)
    originalBranch = git('rev-parse --abbrev-ref HEAD', repoRoot);

    // 2. Create and switch to a new branch
    const timestamp = Date.now();
    const branchName = `ai-heal/${sanitizeBranchName(proposal.locatorKey)}-${timestamp}`;
    git(`checkout -b ${branchName}`, repoRoot);

    // 3. locator-store.json was already updated by approveLocatorProposal().
    //    Stage and commit it. Use a temp file for the commit message to avoid
    //    shell-escaping issues with multi-line text and special characters.
    git(`add locator-store.json`, repoRoot);

    const commitMsg = `ai-heal: update locator "${proposal.locatorKey}"

${proposal.elementName}

Old: ${proposal.oldLocator}
New: ${proposal.newLocator}

Confidence: ${proposal.confidence ?? '-'}
Reason: ${proposal.reason ?? '-'}

Proposal ID: ${proposal.id}
Test: ${proposal.testName ?? '-'}`;

    const msgFile = path.join(os.tmpdir(), `ai-heal-commit-${Date.now()}.txt`);
    fs.writeFileSync(msgFile, commitMsg, 'utf-8');
    try {
      git(`commit -F ${msgFile}`, repoRoot);
    } finally {
      try { fs.unlinkSync(msgFile); } catch { /* best effort */ }
    }

    // 4. Push the branch to origin
    git(`push origin ${branchName}`, repoRoot);

    // 5. Create PR via CNB API
    const repoPath = getRepoPath();
    const prTitle = `ai-heal: 更新定位器 [${proposal.locatorKey}]`;
    const prBody = `## AI 自愈定位器更新

| 字段 | 值 |
|------|-----|
| **元素** | ${proposal.elementName} |
| **Locator Key** | \`${proposal.locatorKey}\` |
| **动作** | ${proposal.action} |
| **置信度** | ${(proposal.confidence * 100).toFixed(0)}% |
| **测试用例** | ${proposal.testName ?? '-'} |
| **页面** | ${proposal.pageUrl ?? '-'} |

### 定位器变更

\`\`\`diff
- ${proposal.oldLocator}
+ ${proposal.newLocator}
\`\`\`

### AI 修复原因

${proposal.reason ?? '-'}

---

此 PR 由飞书审核卡片"确认替换"按钮自动创建。合并后 Jenkins 会自动重跑测试验证新定位器。`;

    const prUrl = await createCNBPullRequest(
      repoPath,
      prTitle,
      branchName,
      originalBranch,
      prBody
    );

    return { ok: true, prUrl, branch: branchName };
  } catch (err: any) {
    return {
      ok: false,
      error: err?.message || String(err),
    };
  } finally {
    // 6. Always restore the original branch, even on failure.
    //    This prevents the repo from being stuck on a feature branch.
    if (originalBranch) {
      try {
        git(`checkout ${originalBranch}`, repoRoot);
      } catch {
        // Best-effort: if checkout fails (e.g. uncommitted changes), force
        // restore locator-store.json to HEAD state.
        try {
          git(`checkout -- locator-store.json`, repoRoot);
        } catch {
          // Give up silently — the PR state is already persisted.
        }
      }
    }
  }
}
