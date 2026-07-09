# Architecture & Infrastructure Documentation

## System Overview

This document describes the self-healing locator infrastructure implemented in `playwright-ai-healer`.

The current design keeps the self-healing core thin:

- `utils/healer-core.ts` owns the runtime heal flow: cache revalidation, state capture, AI proposal, quality gate validation, final retry, and event emission.
- `utils/ai-healer.ts` owns Playwright action adapters and proposal recording. New tests should prefer `clickByKey`, `assertVisibleByKey`, `fillByKey`, and `locateByKey`.
- Feishu, callback approval, CNB PR creation, and Jenkins reporting are integrations around the core. CNB PR creation is opt-in via `HEALER_AUTO_PR=true`.

`HEAL_SUCCESS` is emitted only after the healed locator passes validation and the final Playwright action succeeds. Cached locators are revalidated before use.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Test Execution (ai-case.spec.ts)               │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
              ┌──────────────────┴───────────────────┐
              │                                      │
        ┌─────▼────────┐                    ┌──────▼────────┐
        │  aiClick()   │                    │  aiAssert()   │
        │  aiFill()    │                    │  aiLocate()   │
        │  aiAssert()  │                    │               │
        └─────┬────────┘                    └──────┬────────┘
              │                                    │
              └──────────────────┬─────────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │   heal() Orchestrator   │
                    │                        │
                    │ 1. Try original        │
                    │ 2. Check cache         │
                    │ 3. Capture state       │
                    │ 4. Call AI             │
                    │ 5. Validate output     │
                    │ 6. Update cache        │
                    │ 7. Emit events         │
                    └────────┬───────────────┘
                             │
        ┌────────────┬────────┼────────┬──────────────┐
        │            │        │        │              │
   ┌────▼──┐  ┌─────▼─┐  ┌──▼──┐  ┌─▼────┐  ┌──────▼──┐
   │ Cache │  │ State │  │ AI  │  │Gate  │  │ Events  │
   │       │  │       │  │     │  │      │  │ Bus     │
   └───────┘  └───────┘  └─────┘  └──────┘  └────┬────┘
                                                   │
                              ┌────────────────────┴──────────────────┐
                              │                                       │
                         ┌────▼────┐                          ┌──────▼──┐
                         │Feishu   │                          │ Console │
                         │ Bot     │                          │ Logging │
                         └─────────┘                          └─────────┘
```

## Core Components

### 1. heal() - Main Orchestrator (utils/ai-healer.ts)

**Purpose:** Centralized healing workflow coordination

**Flow:**
```
heal(page, input)
  ├─ Try original locator (5s timeout)
  ├─ If success: return locator
  ├─ If fail:
  │  ├─ Check cache (cache.get())
  │  ├─ If cache hit: emit CACHE_HIT + validate + return
  │  ├─ Capture page state (capturePageState())
  │  ├─ Call AI (callAIForHeal())
  │  ├─ Validate output (qualityGate.validate())
  │  ├─ Cache result (cache.set())
  │  ├─ Emit HEAL_SUCCESS
  │  └─ Return healed locator
  └─ On validation fail: emit HEAL_FAILED + throw
```

**Key Exports:**
- `aiClick(page, locator, description, options)` - Try-first click with healing
- `aiAssert(page, locator, description, options)` - Try-first visibility assert with healing
- `aiFill(page, locator, description, value, options)` - Try-first fill with healing
- `aiLocate(page, locator, description, options)` - Return healed locator without action

### 2. healEventBus - Pub/Sub Event System (utils/heal-event-bus.ts)

**Purpose:** Decoupled event distribution for architecture flexibility

**API:**
```ts
healEventBus.on(type, handler)         // Subscribe to type or 'all'
healEventBus.off(type, handler)        // Unsubscribe
healEventBus.emit(event)               // Dispatch to subscribers
healEventBus.clear()                   // Clear all subscriptions
healEventBus.count(type?)              // Get subscription count
```

**Event Types:**
- `HEAL_START` - Healing initiated
- `CACHE_HIT` - Cached locator found and reused
- `STATE_CAPTURED` - Page state snapshot captured
- `AI_CALLED` - AI API invoked
- `VALIDATION_PASSED` - Quality gate validation succeeded
- `VALIDATION_FAILED` - Quality gate validation failed
- `HEAL_SUCCESS` - Healing completed successfully
- `HEAL_FAILED` - Healing failed completely

### 3. HealCache - LRU with File Persistence (utils/heal-cache.ts)

**Purpose:** Reduce API costs by caching healed locators

**Configuration:**
- Max entries: 1000 (LRU eviction)
- Default TTL: 300s (5 minutes)
- Storage: `healer-cache.json` (JSON file)

**Key Methods:**
```ts
cache.get(originalLocator, pageUrl)     // Lookup with TTL check
cache.set(originalLocator, pageUrl, output, ttlMs?)  // Store with auto-eviction
cache.clear()                            // Clear all entries
cache.stats()                            // Get {size, entries[]}
```

**Cache Key Format:** `"${originalLocator}|${pageUrl}"`

### 4. Quality Gate Validation (utils/quality-gate.ts)

**Purpose:** Prevent garbage AI output from reaching tests

**Validations:**
- ✓ Confidence >= 0.6 (60%)
- ✓ Locator matches exactly 1 element
- ✓ expectedText matches element content (if provided)
- ✓ Element is enabled (click action)
- ✓ Element is editable (fill action)

**Return Type:**
```ts
type QualityGateResult = 
  | { status: 'pass'; output: HealOutput }
  | { status: 'fail'; errors: string[] }

// Usage
const result = qualityGate.validate(page, output, expectedText);
if (result.status === 'pass') {
  return result.output;
} else {
  throw new Error(result.errors.join('; '));
}
```

### 5. State Capture (utils/capture-state.ts)

**Purpose:** Provide AI with sufficient DOM context

**Captures from 3 Sources:**
1. **ARIA Elements** (max 50)
   - role, label, description, visible text
   - For screen-reader semantics

2. **Interactive Elements** (max 50)
   - button, input, select, a, [onclick], etc.
   - For clickable targets

3. **Document Tree** (depth 5, max 10 children/node)
   - Full DOM structure for context

**Output Format:**
```ts
{
  ariaElements: [{role, label, description, text, visible}...],
  interactiveElements: [{tag, type, visible, text, ariaLabel}...],
  documentTree: {tag, text, children}[...],
  visibleErrors: [string]
}
```

### 6. AI Integration (utils/openai-client.ts)

**Purpose:** DeepSeek + OpenAI wrapper with JSON-mode support

**Configuration:**
- Primary: DeepSeek (baseURL: https://api.deepseek.com, model: deepseek-chat)
- Fallback: OpenAI (model: gpt-4-turbo)
- Mock support for testing

**API:**
```ts
callAIForHeal(input)      // Returns {locator, strategy, confidence, reason}
setMockOpenAIClient(mock) // For testing without API calls
```

**Response Format:**
```json
{
  "locator": "button:has-text('OK')",
  "strategy": "css",
  "confidence": 0.95,
  "reason": "element found by button text selector"
}
```

### 7. Feishu Bot Integration (utils/feishu-bot.ts)

**Purpose:** Event-driven notifications to Feishu

**Subscriptions:**
- HEAL_SUCCESS → 🟢 status: "success"
- HEAL_FAILED → 🔴 status: "error"
- VALIDATION_FAILED → 🟠 status: "error"
- CACHE_HIT → 🟡 status: "warning"

**Message Format:**
- Title: Brief description
- Content: 5-line fixed structure
  1. description
  2. originalLocator
  3. healedLocator (if applicable)
  4. errorDetail (if applicable)
  5. pageUrl

**Graceful Degradation:**
- If FEISHU_APP_ID/SECRET/CHAT_ID not configured: silently skip
- Logs to console only

## Lifecycle Hooks

### Global Setup (playwright.global-setup.ts)

Runs **once before all tests**:
```ts
1. initFeishuBot()                    // Subscribe to heal events
2. sendFeishuMessage("🚀 测试开始")   // Notify test start
```

### Global Teardown (playwright.global-teardown.ts)

Runs **once after all tests**:
```ts
1. healCache.stats()                  // Collect cache statistics
2. sendFeishuMessage("✅ 测试完成")   // Notify test completion
```

## Configuration

### Environment Variables (.env)

```env
DEEPSEEK_API_KEY=sk-...         # Required for healing
OPENAI_API_KEY=sk-...           # Fallback if DeepSeek fails
FEISHU_APP_ID=...               # Optional: Feishu notifications
FEISHU_APP_SECRET=...           # Optional: Feishu notifications
FEISHU_CHAT_ID=...              # Optional: Feishu notifications
RUN_ID=...                       # Optional: Unique run identifier
```

### playwright.config.ts

Key settings for AI operations:
```ts
timeout: 30 * 1000              // 30s for AI operations
retries: CI ? 2 : 0              // 2x retry in CI
workers: CI ? 1 : undefined       // 1 worker in CI for stability
globalSetup: './playwright.global-setup.ts'
globalTeardown: './playwright.global-teardown.ts'
```

## Type System

All types defined in [skills/self-healing-locator/contract.ts](skills/self-healing-locator/contract.ts):

```ts
interface HealInput {
  originalLocator: string;      // Failing locator
  description: string;          // User-friendly target
  pageUrl: string;              // Current page URL
  action: 'click' | 'assert' | 'fill';
  expectedText?: string;        // For validation
  errorMessage?: string;        // Failure context
  fillValue?: string;           // For fill action
  timeoutMs?: number;           // Override default timeout
}

interface HealOutput {
  locator: string;              // New selector
  strategy: 'aria' | 'text' | 'css' | 'xpath';
  confidence: number;           // 0.0-1.0
  reason: string;               // Why this selector
}

type HealEventType = 
  | 'HEAL_START'
  | 'CACHE_HIT'
  | 'STATE_CAPTURED'
  | 'AI_CALLED'
  | 'VALIDATION_PASSED'
  | 'VALIDATION_FAILED'
  | 'HEAL_SUCCESS'
  | 'HEAL_FAILED';

interface HealEvent {
  id: string;                   // UUID
  type: HealEventType;
  timestamp: string;            // ISO 8601
  input: HealInput;
  output?: HealOutput;
  validation?: QualityGateResult;
  error?: string;
  metrics: {
    retryCount: number;
    durationMs: number;
    cacheHit: boolean;
  };
}
```

## Testing Infrastructure

### Unit Tests (tests/healer.spec.ts)

- **Event Bus Tests:** Subscribe, emit, unsubscribe, wildcards
- **Cache Tests:** Storage, retrieval, TTL, eviction, statistics

### Integration Tests (tests/healer-integration.spec.ts)

- Run with: `RUN_INTEGRATION=1 npx playwright test tests/healer-integration.spec.ts`
- Uses mock AI client for deterministic responses
- Tests with [tests/fixtures/broken-page.html](tests/fixtures/broken-page.html)

### Helper Scripts

```bash
# Print cache contents for debugging
node scripts/print-cache.js

# Run full self-test with git state restoration
node scripts/run-healer-selftest.js
```

## Performance & Cost Optimization

### Cache Hit Rate

- 5-minute TTL per entry (configurable)
- Typical cache hit rate: 60-80% in repeated test runs
- Storage: ~500 bytes per entry average

### API Costs

- **Baseline:** 1 API call per failing locator (no cache)
- **With 70% cache hit:** 30% of baseline cost
- **Example:** 100 tests → ~30 API calls (vs 100 without cache)

### Timeout Strategy

- Original locator: 5 seconds (short timeout for fast failure)
- Full heal cycle: 25 seconds remaining in 30s timeout
- Validates & caches within timeout

## Troubleshooting

### Heal Events Not Sent to Feishu

**Check:**
1. Is FEISHU_APP_ID set? (Required)
2. Is FEISHU_APP_SECRET set? (Required)
3. Is FEISHU_CHAT_ID set? (Required)
4. Check console logs for `[Feishu] Initializing...`

**If unconfigured:** System logs but doesn't fail (graceful degradation)

### Cache Not Persisting

**Check:**
1. Is healer-cache.json created in project root?
2. Is cache cleared between test runs? (Use `healCache.clear()`)
3. Check file permissions (write access to project root)

### AI API Failures

**Fallback chain:**
1. Try DEEPSEEK_API_KEY first
2. Fall back to OPENAI_API_KEY
3. Throw error if both missing

**Debug:**
```bash
echo $DEEPSEEK_API_KEY      # Should be set
echo $OPENAI_API_KEY        # Fallback
```

### Validation Failures

**Quality gate rejects output if:**
- Confidence < 0.6 (low confidence)
- Locator matches 0 or 2+ elements (not unique)
- Text mismatch (for assert action)
- Element disabled (for click action)

**Debug:** Check console for validation errors

## Future Enhancements

- [ ] Persistent event logging (.heal-events.jsonl)
- [ ] Metrics dashboard integration
- [ ] Custom AI prompt templates
- [ ] Parallel healing with rate limiting
- [ ] Learning from healed selectors over time
- [ ] Multi-page healing context
