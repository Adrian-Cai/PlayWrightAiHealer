# Self-Healing Locator Skill — Design Spec

- **Date:** 2026-06-16
- **Project:** `playwright-ai-healer`
- **Author context:** 与公众号文章《从 Prompt 到 Skills：测试场景的 AI 能力建模》(2026 第二篇) 的 6 组件 Skill 框架对齐的实战落地方案
- **Repo:** `C:\Users\ImAca\AllProject\playwright-ai-healer`
- **Status:** Draft (pending user review)

---

## 1. Background & Motivation

### 1.1 真实问题

团队已经在 `https://ai-case.wiac.xyz/` 这个项目平台上跑 Playwright 自动化。上一次在 Jenkins 上跑 `tests/ai-case.spec.ts` 时，**进入当前项目页面 → 点击【人工确认】菜单项** 这一步因为元素定位器失效而中断。手动排查后确认：定位器 `.ant-menu-item:has-text("人工确认")` 已经不再匹配（前端菜单结构升级，class 变化、文本也改了位置）。

这是一个典型的"测试脚本因 UI 变更而脆断"问题。手工维护定位器成本高、跨人传递易失。

### 1.2 现状盘点

仓库已经存在以下产物（约 60% 完成度）：

| 模块 | 现状 | 缺口 |
|---|---|---|
| `tests/ai-case.spec.ts` | 14 行，已用 `aiClick` 包装 | 只覆盖 click，没覆盖 fill/assert/locate |
| `utils/ai-healer.ts` | 90 行，单文件，try-catch + AI 一次性调用 | 没有 Quality Gate、没有 JSON 结构化输出、没有缓存、不可观测 |
| `utils/feishu-bot.ts` | 41 行，仅 `sendFeishuMessage(title, content, status)` | 与 healer 直接耦合，没有事件总线 |
| `Jenkinsfile` | 35 行骨架，使用 `credentials()` 注入环境变量 | 缺 START/END 通知、缺事件归档 |
| `playwright.config.ts` | 默认 Desktop Chrome + HTML reporter | 没接 globalSetup/globalTeardown |
| `package.json` | 已装 `@playwright/test`, `axios`, `dotenv`, `openai` | 没有 `test` / `test:healer` 脚本 |
| `.env` | 占位 | 需要补真实 key（不在本 spec 范围） |

### 1.3 目标

依据文章中"测试任务被结构化"的思路，把"自愈定位器"这件事本身**建模为一个 6 组件 Skill**，并配上 Quality Gate、文件缓存、事件总线、4 节点飞书通知、Jenkins 流水线，让它从一段"个人 Prompt"升级为"团队能力"。

---

## 2. Scope

### 2.1 In Scope（本 spec 内必须完成）

- 把 `ai-healer.ts` 重写为符合文章 6 组件模型的 Skill 入口
- 新增 4 个动作包装：`aiClick` / `aiFill` / `aiAssert` / `aiLocate`
- Quality Gate：结构化 JSON 输出 + 二次校验（visibility / uniqueness / text match）+ confidence 阈值
- 三路状态采集：Accessibility Tree + 可见交互元素 + 原始错误
- Healer 缓存：进程内 LRU + `healer-cache.json` 落盘
- 事件总线：`utils/heal-event-bus.ts`，订阅者包括 feishu-bot / cache-writer / jsonl-writer / stdout-logger
- 4 节点飞书：START / HEAL_SUCCESS / HEAL_FAIL / END
- Playwright `globalSetup` / `globalTeardown` 触发 START / END
- Jenkinsfile 改造：加 `archiveArtifacts` 把 `.heal-events.jsonl` 和 `healer-cache.json` 归档
- 自愈 Smoke 测试：`tests/healer.spec.ts` + `tests/fixtures/broken-page.html`
- `package.json` 加 `test` / `test:healer` / `healer:cache:print` 脚本

### 2.2 Out of Scope（不在本 spec 范围）

- 替换 OpenAI 为其他模型（保持 `gpt-4o-mini`，可后续切换）
- 跨进程/跨 Jenkins agent 的集中式缓存
- 飞书自建 App（仅用 Webhook + 富文本 post）
- 浏览器多端（仅 Desktop Chrome）
- 截图自动上传（HEAL_* 节点暂不带截图 URL，留 hook 后续接对象存储）
- `ai-case.wiac.xyz` 项目本身的测试用例扩展（仍以 `tests/ai-case.spec.ts` 一个 smoke 为基线）
- `.env` 真实 key 配置（需要用户在 Jenkins 凭据里维护）

---

## 3. Skill 6 组件模型

按文章第四节的"建模五问"+ 6 部分，对 **Self-Healing Locator Skill** 的定义：

### 3.1 任务目标

当 Playwright 元素定位器失效时，自动生成等效新定位器让测试不中断；并把每次自愈作为可审计事件落到 `.heal-events.jsonl` + 飞书，让团队能看到"哪些定位器反复在坏"、"AI 在哪些场景下搞不定"。

### 3.2 输入契约

```ts
interface HealInput {
  originalLocator: string;       // 必填：失败的原定位器
  description: string;            // 必填：元素中文/英文描述
  pageUrl: string;                // 必填：当前 URL（用于 cache key glob）
  action: 'click' | 'fill' | 'assert' | 'locate';  // 必填
  expectedText?: string;          // 可选：期望可见文本，用于二次校验
  errorMessage?: string;          // 可选：原始 Playwright 报错
  timeoutMs?: number;             // 可选：原 timeout，默认 5000
}
```

调用方通过 4 个动作包装传入（详见 §6）。

### 3.3 上下文约束

- **站点域**：仅针对 `https://ai-case.wiac.xyz/*`（Antd 5 风格）
- **元素优先级**：`button > a > .ant-menu-item > .ant-btn > [role="button"] > input/select`
- **策略优先级**：`aria > text > css > xpath`
- **黑名单**：禁止输出形如 `*[id^="rc-"]` 或 `*[class*="css-"]` 等明显是运行时生成的随机 ID
- **描述语义**：description 必须是元素的目的（如"人工确认菜单项"），不能是位置（如"页面左上角第三个按钮"）

### 3.4 判断流程

```
1. lookupCache(originalLocator, pageUrl) ──hit──► 短路返回（不再调 AI）
        │ miss
        ▼
2. captureState(page) → { aria, interactive, error }
        │
        ▼
3. callOpenAI(input, state) → HealOutput（JSON mode 强约束）
        │
        ▼
4. validate(healed, page, ctx) ──ok──► writeCache + emit('heal-success') + 继续
        │ fail
        ▼
   emit('heal-fail') → 抛原 Playwright 错误（不重试 AI，避免放大错误）
```

每一步都有日志（stdout）输出，便于调试。

### 3.5 输出契约

```ts
interface HealOutput {
  locator: string;                // AI 建议的新定位器
  strategy: 'aria' | 'text' | 'css' | 'xpath';
  confidence: number;             // 0.0 - 1.0
  reason: string;                 // AI 解释为什么这样改
}
```

约束：
- `confidence < 0.6` → 视为不可信
- `strategy` 与 `locator` 形态必须自洽（如 `strategy: 'xpath'` 时 `locator` 必须以 `//` 或 `xpath=` 开头）
- `reason` 不超过 200 字

### 3.6 适用边界

**不适用**（应让测试失败，由人介入）：

1. 跨域 iframe 内部元素
2. Shadow DOM 内部
3. `<canvas>` / `<svg>` 内部图形
4. 完全由 JS 动态随机生成的 ID
5. 原 locator 拼写错误（如 `.btn-priamry`、`#submiit` 这种 typo；说明测试代码 bug，应让测试红，由开发者修正测试代码）
6. `description` 中包含"第 N 个"等位置描述（信号是测试设计问题）
7. AI confidence < 0.6

**适用**（正常走自愈）：

- 元素可见且文本稳定，但 class / role / 父级结构变化（最常见场景）
- 元素文本改了措辞但语义没变（如"确认" → "批量确认"）

---

## 4. Quality Gate

### 4.1 二次校验伪代码

```ts
type ValidationResult =
  | { ok: true }
  | { ok: false; reason: 'low_confidence' | 'invalid_syntax' | 'locator_throw' | 'not_unique' | 'not_visible' | 'text_mismatch'; detail?: string };

async function validate(healed: HealOutput, page: Page, ctx: HealInput): Promise<ValidationResult> {
  // 1) 基础语法
  if (healed.confidence < 0.6) return { ok: false, reason: 'low_confidence', detail: `confidence=${healed.confidence}` };
  if (!isValidSyntax(healed.locator, healed.strategy)) return { ok: false, reason: 'invalid_syntax' };

  // 2) 页面上能定位
  let loc;
  try {
    loc = page.locator(healed.locator);
  } catch (e: any) {
    return { ok: false, reason: 'locator_throw', detail: e.message };
  }

  // 3) 唯一性
  const count = await loc.count();
  if (count !== 1) return { ok: false, reason: 'not_unique', detail: `count=${count}` };

  // 4) 可见性
  if (!(await loc.isVisible())) return { ok: false, reason: 'not_visible' };

  // 5) 文本一致性（如果调用方给了 expectedText）
  if (ctx.expectedText) {
    const text = (await loc.textContent()) ?? '';
    if (!text.includes(ctx.expectedText)) return { ok: false, reason: 'text_mismatch', detail: `got="${text.slice(0, 50)}"` };
  }

  return { ok: true };
}
```

### 4.2 Fallback 链

| 优先级 | 路径 | 资源消耗 |
|---|---|---|
| 1 | 命中 cache | 0 token, <1ms |
| 2 | AI 一次过 Quality Gate | 1 call (~500-2000ms, ~1500 tokens) |
| 3 | AI 不过 | 抛原 Playwright 错误；不重试 AI |

**不重试 AI 的原因**：如果 AI 一次给的 locator 都不通过，多半是 description 与 DOM 严重不匹配、或 DOM 还没渲染完。重试只是浪费 token，倾向于让测试红、人工定位。

### 4.3 阈值与可调参数

| 参数 | 默认值 | 出处 |
|---|---|---|
| `confidence` 阈值 | 0.6 | Quality Gate |
| 缓存 LRU size | 200 | `heal-cache.ts` |
| 原 locator timeout | 5000ms | `ai-healer.ts` |
| AI call timeout | 15000ms | `openai-client.ts` |

未来可以收敛为 `utils/config.ts` 集中管理（不在本 spec 范围）。

---

## 5. Healer Cache

### 5.1 文件格式

`healer-cache.json`：

```json
{
  "v1": [
    {
      "key": "sha1(originalLocator + pageUrlPattern)",
      "original": ".ant-menu-item:has-text(\"人工确认\")",
      "healed": "[role='menuitem']:has-text('人工确认')",
      "strategy": "aria",
      "confidence": 0.92,
      "pageUrlPattern": "https://ai-case.wiac.xyz/*",
      "hits": 3,
      "updatedAt": "2026-06-16T08:30:00.000Z"
    }
  ]
}
```

### 5.2 行为

- 启动时一次性读入内存 LRU
- 自愈成功时按 `key` 去重后追加 + 落盘
- 不做 TTL（让 `hits` 字段反映长期有效性）
- `hits` 字段每次 cache hit 递增（便于后续看哪些定位器最脆弱）
- 手动清理：删除 `healer-cache.json` 即可，代码会自然重新自愈

### 5.3 Cache Key 设计

```
key = sha1(originalLocator + "|" + pageUrlPattern)
```

`pageUrlPattern` 是带通配符的 glob（如 `https://ai-case.wiac.xyz/*`），命中时按"原 locator 完全相等 + pageUrl glob 匹配"判断。

---

## 6. 动作包装 API

### 6.1 `aiClick`

```ts
export async function aiClick(
  page: Page,
  locatorStr: string,
  description: string,
  options?: { expectedText?: string; timeoutMs?: number }
): Promise<void>
```

行为：尝试 `page.locator(locatorStr).click()`，失败时走自愈。

### 6.2 `aiFill`

```ts
export async function aiFill(
  page: Page,
  locatorStr: string,
  description: string,
  value: string,
  options?: { expectedText?: string; timeoutMs?: number }
): Promise<void>
```

行为：先 click 进 input，再 fill。`expectedText` 通常是 input 的 placeholder 或 label。

### 6.3 `aiAssert`

```ts
export async function aiAssert(
  page: Page,
  locatorStr: string,
  description: string,
  options?: { expectedText?: string; timeoutMs?: number }
): Promise<void>
```

行为：定位元素、断言可见 + 文本一致。失败时同样走自愈（自愈后再次断言）。

### 6.4 `aiLocate`

```ts
export async function aiLocate(
  page: Page,
  locatorStr: string,
  description: string,
  options?: { expectedText?: string; timeoutMs?: number }
): Promise<Locator>
```

行为：不执行动作，只返回自愈后的 Locator。供后续 `await loc.click()` 链式调用。

### 6.5 共用逻辑

4 个包装内部统一走 `utils/ai-healer.ts` 的 `selfHeal()`，不重复实现。

**前置约束**（4 个包装统一执行）：
- `description` 必须是非空字符串；空字符串或仅空白字符应抛 `Error: description cannot be empty`（这是测试代码 bug，不是自愈场景）
- `originalLocator` 必须是合法 CSS / XPath / Playwright 字符串，否则抛 `Error: invalid originalLocator`

---

## 7. 事件总线与飞书

### 7.1 HealEvent 形状

```ts
type HealEvent =
  | { type: 'start';    ts: string; runId: string; project: string; commit?: string; browser: string }
  | { type: 'heal-success'; ts: string; runId: string; original: string; healed: string; strategy: 'aria' | 'text' | 'css' | 'xpath'; confidence: number; reason: string; pageUrl: string; durationMs: number }
  | { type: 'heal-fail';    ts: string; runId: string; original: string; aiCandidate?: string; reason: string; pageUrl: string; durationMs: number }
  | { type: 'end';      ts: string; runId: string; status: 'passed' | 'failed' | 'errored'; passed: number; failed: number; skipped: number; healSuccessCount: number; healFailCount: number; reportUrl?: string };
```

### 7.2 订阅者

| Subscriber | 职责 |
|---|---|
| `feishu-bot` (HEAL_* only) | 翻译为飞书 post，发到 Webhook |
| `cache-writer` (HEAL_SUCCESS only) | 监听 `heal-success`，更新 `healer-cache.json` |
| `jsonl-writer` (ALL events) | 监听所有事件，append 到 `.heal-events.jsonl` |
| `stdout-logger` (ALL events) | 监听所有事件，console.log 一行 JSON |

START / END 节点不通过事件总线，直接由 `playwright.global-setup.ts` / `playwright.global-teardown.ts` 调用 `feishu-bot.sendStart()` / `feishu-bot.sendEnd()`（这两个方法是 feishu-bot 内部直接方法，不在事件总线协议里）。HEAL_SUCCESS / HEAL_FAIL 由 `ai-healer.ts` 在 Quality Gate 通过/失败时通过 `bus.emit(...)` 触发，4 个订阅者同时收到。

### 7.3 4 节点飞书消息格式

#### START（蓝）

```
🚀 测试启动
项目: playwright-ai-healer
Commit: <git short SHA>（无 git 仓库时显示 "local"）
URL: https://ai-case.wiac.xyz/
浏览器: Desktop Chrome
触发: Jenkins #<buildNumber>（本地运行时显示 "local"）
```

#### HEAL_SUCCESS（绿）

```
✅ 自愈成功
元素: 人工确认菜单项
原始定位器: .ant-menu-item:has-text("人工确认")
新定位器: [role='menuitem']:has-text('人工确认')
策略: aria
置信度: 0.92
原因: 原 locator 指向 .ant-menu-item，但 antd 5 菜单已迁移到 [role="menuitem"]
页面: https://ai-case.wiac.xyz/
耗时: 1240ms
```

#### HEAL_FAIL（黄）

```
⚠️ 自愈失败
元素: 批量确认按钮
原始定位器: button:has-text("批量确认")
AI 候选: [role='button']:has-text('确认')
失败原因: not_unique (count=3)
建议: 检查页面是否同时存在多个"确认"按钮；或人工更新测试定位器
页面: https://ai-case.wiac.xyz/
```

#### END（绿/红）

```
🏁 测试结束
状态: ✅ 通过 / ❌ 失败
用例: 通过 5 / 失败 0 / 跳过 0
自愈: 成功 2 / 失败 0
报告: <link to playwright-report/index.html>
触发: Jenkins #<buildNumber>
```

### 7.4 触发时机

- **START**：`playwright.global-setup.ts` 中 `feishu-bot.sendStart()`
- **HEAL_SUCCESS / HEAL_FAIL**：`utils/ai-healer.ts` 在 Quality Gate 通过/失败时 `bus.emit(...)`
- **END**：`playwright.global-teardown.ts` 中读 `.heal-events.jsonl` + `test-results/.last-run.json` 后 `feishu-bot.sendEnd()`

`runId` 通过 `process.env.RUN_ID || crypto.randomUUID()` 生成，贯穿整次运行。

---

## 8. Jenkins 流水线

```groovy
pipeline {
  agent any
  environment {
    OPENAI_API_KEY     = credentials('OPENAI_API_KEY')
    FEISHU_WEBHOOK_URL = credentials('FEISHU_WEBHOOK_URL')
    RUN_ID             = "${BUILD_NUMBER}-${env.GIT_COMMIT?.take(7)}"
  }
  stages {
    stage('Checkout')  { steps { checkout scm } }
    stage('Install')   { steps { sh 'npm ci'; sh 'npx playwright install --with-deps chromium' } }
    stage('Test')      { steps { sh 'npx playwright test' } }
  }
  post {
    always {
      publishHTML(target: [
        reportDir: 'playwright-report',
        reportFiles: 'index.html',
        reportName: 'Playwright Report'
      ])
      archiveArtifacts artifacts: '.heal-events.jsonl,healer-cache.json',
                       allowEmptyArchive: true,
                       fingerprint: false
    }
  }
}
```

START/END 飞书消息由 `globalSetup`/`globalTeardown` 在 Jenkins 容器内直接发（不需要 `node scripts/notify-feishu.js` 这种边路脚本）。

如果 `FEISHU_WEBHOOK_URL` 未配置或为占位值，所有飞书调用走 console.log 兜底，测试不会因为飞书配置缺失而失败。

---

## 9. 测试策略

### 9.1 单元测试（mock OpenAI）

`tests/healer.spec.ts`：

| Case | 验证 |
|---|---|
| `validate_lowConfidence_returnsFail` | AI 给 0.5，返回 fail('low_confidence') |
| `validate_notUnique_returnsFail` | AI 给的 locator 在页面上匹配 3 个元素，返回 fail('not_unique') |
| `validate_textMismatch_returnsFail` | expectedText="提交" 但实际文本是"取消"，返回 fail('text_mismatch') |
| `validate_happyPath_returnsOk` | 唯一 + 可见 + 文本一致，返回 ok |
| `cacheWrite_dedupesByKey` | 同一 key 写两次，文件里只一条 |
| `eventBus_dispatchesToAllSubscribers` | emit('heal-success') 4 个订阅者都收到 |

mock 方式：在 `openai-client.ts` 中通过 `process.env.HEALER_MOCK_RESPONSE` 环境变量或工厂注入。

### 9.2 集成测试（real OpenAI，限本地）

`tests/healer-integration.spec.ts`，受 `process.env.RUN_INTEGRATION === '1'` 守门：

- 启动 `tests/fixtures/broken-page.html`（通过 `file://` 或 `npx http-server`）
- 故意用坏 locator 调用 `aiClick`
- 验证自愈成功 + 飞书 webhook 被调用（用 `axios-mock-adapter` 拦截）

### 9.3 Healer 自检（dev 工具）

`npm run healer:selftest`（**仅限本地有 git 仓库时使用**）：
- 通过 `git stash` 把当前 `tests/ai-case.spec.ts` 备份起来
- 临时把 `tests/ai-case.spec.ts` 的第一行 locator 改成 `.ant-menu-item-broken:has-text("人工确认")`
- 跑 `aiClick` 自愈
- 用 `git stash pop` 恢复（**任何异常路径都 try-finally 保证恢复**）
- 输出自愈报告

这是开发期手动验证手段，不进 CI。脚本本身在 §10.1 中作为 `scripts/run-healer-selftest.js` 落地（避免和 `playwright test` runner 冲突）。

### 9.4 Quality Gate 反向测试

mock OpenAI 返回一个故意 hallucinate 的 locator（如指向不存在的元素）：
- 验证 `validate` 返回 fail
- 验证 `healer-cache.json` 没有写入
- 验证没有 emit('heal-success')
- 验证 emit('heal-fail') 被调用

---

## 10. File / Module Structure

### 10.1 新增文件

| 路径 | 职责 |
|---|---|
| `skills/self-healing-locator/SKILL.md` | Skill 元描述（任务/输入/输出/边界），按文章 6 组件格式 |
| `skills/self-healing-locator/contract.ts` | TypeScript 接口：`HealInput`, `HealOutput`, `HealEvent` |
| `utils/capture-state.ts` | 三路状态采集（ARIA + 可见交互 + 错误） |
| `utils/openai-client.ts` | OpenAI JSON mode 封装 + mock 钩子 |
| `utils/quality-gate.ts` | 二次校验逻辑 |
| `utils/heal-cache.ts` | LRU + 文件落盘 |
| `utils/heal-event-bus.ts` | 事件总线 + 订阅者注册 |
| `utils/ai-healer.ts` | 重写为 Skill 入口，串联上面 4 个模块 |
| `utils/ai-click.ts` | `aiClick` 包装 |
| `utils/ai-fill.ts` | `aiFill` 包装 |
| `utils/ai-assert.ts` | `aiAssert` 包装 |
| `utils/ai-locate.ts` | `aiLocate` 包装 |
| `playwright.global-setup.ts` | START 飞书 + 注册订阅者 |
| `playwright.global-teardown.ts` | END 飞书 + 清理 |
| `tests/healer.spec.ts` | 自愈单元测试（mock OpenAI） |
| `tests/healer-integration.spec.ts` | 集成测试（real OpenAI，守门环境变量） |
| `tests/fixtures/broken-page.html` | 故意写错 className 的 Antd 风格页面 |
| `scripts/print-cache.js` | 调试：输出当前 healer-cache 内容 |
| `scripts/run-healer-selftest.js` | 9.3 描述的 Healer 自检脚本（git stash + 改 locator + 恢复） |

### 10.2 修改文件

| 路径 | 改动 |
|---|---|
| `tests/ai-case.spec.ts` | 改用 `aiClick` + `aiAssert`（语义保持：进入页面 → 人工确认 → 断言批量确认存在） |
| `Jenkinsfile` | 加 `archiveArtifacts`，注入 `RUN_ID` |
| `package.json` | 加 `scripts: { "test": "playwright test", "test:healer:integration": "RUN_INTEGRATION=1 playwright test tests/healer-integration.spec.ts", "healer:cache:print": "node scripts/print-cache.js", "healer:selftest": "node scripts/run-healer-selftest.js" }` |
| `playwright.config.ts` | 接 `globalSetup` / `globalTeardown`；加 `timeout: 30000`（给 AI call 留时间） |
| `utils/feishu-bot.ts` | 改为订阅事件总线（不是被 healer 直接调用）；新增 `sendStart` / `sendEnd` 方法 |

### 10.3 删除文件

无删除。`utils/ai-healer.ts` 是重写不是删除。

---

## 11. Risks & Mitigations

| 风险 | 缓解 |
|---|---|
| AI 把对的定位器改错 | Quality Gate 二次校验 + 不重试 |
| 缓存里有错的自愈结果 | `npm run healer:cache:print` + 手工删 JSON 条目；未来加 "撤销" 命令 |
| OpenAI API 抖动导致 CI 失败 | 单元测试不依赖网络；CI 中 AI 调用加 try-catch 兜底走 `heal-fail` |
| 飞书 Webhook 不可达 | `sendFeishuMessage` 内部 try-catch，仅 console.log 错误，不抛 |
| DOM 还没渲染完就开始自愈 | `aiClick` / `aiFill` 内部 `await page.waitForLoadState('networkidle')`（现有 Playwright 默认行为） |
| 描述与 DOM 严重不匹配时 AI 给置信度高 | Quality Gate 二次校验会兜住（count/visibility/text 都对不上时 fail） |
| 同一运行多次自愈的成本 | 缓存命中短路；正常一次运行 1-3 次自愈，token 成本可接受 |

---

## 12. Open Questions (待确认)

- [ ] 飞书消息里要不要带 base64 截图？当前决定：**不带**（避免 webhook 体积过大），后续接对象存储再说
- [ ] `RUN_ID` 格式：当前用 `${BUILD_NUMBER}-${GIT_COMMIT:7}`，需要 Jenkins 端确认
- [ ] `healer:selftest` 的"自检"是否进 CI？当前决定：**不进**，作为开发期工具

---

## 13. Acceptance Criteria

满足以下全部条件即视为本 spec 完成：

1. `npm test` 在 `tests/ai-case.spec.ts` 上以原始 locator 通过
2. 手动把 `tests/ai-case.spec.ts` 的 locator 改坏一行（加 `-broken`），`npm test` 仍然通过（即触发自愈）
3. 跑测试后 `.heal-events.jsonl` 至少包含 `start` 和 `end` 事件
4. 跑测试后 `healer-cache.json` 包含新的成功自愈条目
5. 配置真实 `FEISHU_WEBHOOK_URL` 后，4 个节点都能在飞书收到消息
6. `npm run healer:cache:print` 能输出当前缓存
7. `npm run test:healer:integration` 在 `RUN_INTEGRATION=1` 下能跑通（可选，本地验证）
8. Quality Gate 反向测试通过：mock 给故意 hallucinate 的 locator 时，不写缓存、不发 HEAL_SUCCESS
