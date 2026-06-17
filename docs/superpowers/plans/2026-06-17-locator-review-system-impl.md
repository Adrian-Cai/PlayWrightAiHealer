# AI Locator Review System — 开发计划

- **Date:** 2026-06-17
- **Project:** `playwright-ai-healer`
- **Status:** Draft (pending user review)
- **Relation:** 这是 `specs/2026-06-16-self-healing-locator-skill-design.md` 的**延续**，不是替代。6 组件架构（事件总线 / 缓存 / Quality Gate / JSONL 收集器 / Reporter / 飞书卡片）保留并复用，本计划只在其上叠加"人工审核闭环"。

---

## 0. 一句话目标

把现有的"AI 自愈后直接用 + 写缓存"升级为"AI 自愈后只在本运行内用 + 跨运行必须人工审核 + 飞书点按钮确认 + 自动改 `locator-store.json` + 可选提 PR"。

定位器集中到 `locator-store.json`，测试脚本只用 `locatorKey`，AI 永远不碰测试代码。

---

## 1. 目标拆解（先把目标拆清楚）

用户原始链路拆成 4 期，每期独立可交付、可验证、可回滚：

| 期 | 目标 | 交付物 | 可验证标志 |
|---|---|---|---|
| **Phase 1** | 定位器集中管理 + ByKey API | `locator-store.json` + `aiClickByKey/aiAssertByKey/aiFillByKey/aiLocateByKey` | `npx playwright test` 通过，spec 不再写死 locator 字符串 |
| **Phase 2** | 提案持久化 + 审核 Reporter | `healer-proposal-store.ts` + 飞书"待审核"卡片（仅展示，无按钮） | 故意改坏 locator → 跑完 → 飞书卡片列出 pending 提案 |
| **Phase 3** | 飞书交互回调 | `scripts/feishu-callback-server.js` + 卡片"确认替换/拒绝"按钮 + 签名校验 | 飞书点"确认替换" → `locator-store.json` 被改写 |
| **Phase 4**（可选） | Git PR 自动化 | 审核通过后自动建分支/提交/推 CNB/创 PR | 飞书点"确认替换" → CNB 出现一个 PR |

**关键约束**：Phase 1 不依赖 Phase 2-4，Phase 2 不依赖 Phase 3-4。每期结束都能 `npx playwright test` 跑通且不回归。

---

## 2. 与用户原方案的关键差异（优化点）

用户原方案（见对话）整体方向正确，但有 8 处需要修正，否则要么破坏现有代码、要么留安全/并发漏洞：

| # | 原方案问题 | 本计划做法 |
|---|---|---|
| 1 | **重写 `ai-healer.ts`**，丢弃现有 6 组件（事件总线/缓存/Quality Gate/JSONL/Reporter） | **做加法**：新增 `aiClickByKey` 等薄包装，内部委托给现有 `aiClick`，复用全部已有自愈管线。AGENTS.md 明确警告"别按 spec 直接动 `utils/ai-healer.ts`" |
| 2 | **重写 `playwright.config.ts`**，丢掉 `globalSetup/globalTeardown`、`list` reporter、`timeout:30000`、`fullyParallel:false` | **不动 config 主结构**，仅在 Phase 2 给 reporter 加一个 `sendReviewCard` 调用入口 |
| 3 | **跨运行缓存自动应用** 与"人工审核"目标冲突：`heal-cache.ts` 构造时从磁盘加载，300s TTL 内下次运行直接复用 AI locator，绕过审核 | **globalSetup 里清缓存**（`healCache.clear()`），让缓存退化为**纯运行内去重**；跨运行的唯一持久路径是审核通过的 proposal |
| 4 | **飞书回调零校验**，任何人 POST 都能改 `locator-store.json` | **必须做**：URL verification challenge 回显 + `X-Lark-Signature` 签名校验（用 App Encrypt Key）+ 可选 `HEALER_CALLBACK_TOKEN` 共享密钥兜底 |
| 5 | **回调服务跑在 Jenkins agent**，但 agent 无稳定公网入口，飞书回调打不进来 | 回调服务必须部署在**稳定常驻主机**（独立小服务/长连接模式）；Jenkins agent 只跑测试 + 发卡片，不接回调。本地开发用长连接或内网穿透 |
| 6 | **引入 `express` + `tsx`** 新依赖，与 AGENTS.md"不加 tsconfig/ESLint"精神相悖 | 回调服务用 **Node 内置 `http` 模块**写纯 `.js`，放 `scripts/`，零新依赖 |
| 7 | **同一 locatorKey 在多 case 失败会产生 N 条重复提案** | 提案按 `locatorKey + oldLocator + newLocator` **去重**；且现有 `healCache` 已保证同运行内同 key 只调 1 次 AI |
| 8 | **`fullyParallel: true`** 会导致多 worker 并发写 `healer-proposals.json` 竞态 | **保持 `fullyParallel: false`**（当前 config 已是），与现有 JSONL 收集器一致 |

---

## 3. 架构总览

```text
                    ┌─────────────────────────────────────────┐
  tests/*.spec.ts   │  aiClickByKey / aiAssertByKey / ...     │  ← Phase 1 新增（薄包装）
  (只用 locatorKey) └──────────────┬──────────────────────────┘
                                  │ getLocator(key)
                                  ▼
                         ┌────────────────────┐
                         │ locator-store.json │  ← Phase 1 新增（唯一真相源，提交进 git）
                         └─────────┬──────────┘
                                   │ locator 字符串
                                   ▼
           ┌───────────────────────────────────────────┐
           │  现有 aiClick / aiAssert / heal()         │  ← 不动
           │  cache → capture → AI → QualityGate → emit│
           └───────────────┬───────────────────────────┘
                           │ HEAL_SUCCESS 事件
                           ▼
                  ┌────────────────────┐
                  │ healEventBus       │  ← 不动
                  └─────┬──────────────┘
                        │
          ┌─────────────┼──────────────────────────┐
          ▼             ▼                          ▼
  ┌──────────────┐ ┌────────────────┐  ┌────────────────────────┐
  │ healer-      │ │ healCache      │  │ Phase 2 新增：proposal- │
  │ collector    │ │ (运行内去重)   │  │ collector 订阅          │
  │ (JSONL)      │ │                │  │ HEAL_SUCCESS → 写提案   │
  └──────┬───────┘ └────────────────┘  └───────────┬────────────┘
         │                                         ▼
         ▼                                ┌──────────────────────┐
  ┌──────────────────┐                    │ healer-proposals.json│  ← Phase 2（test-results/，不提交）
  │ feishu-reporter  │                    └──────────┬───────────┘
  │ onEnd 汇总       │                               │
  └────────┬─────────┘                               │
           ▼                                         ▼
  ┌──────────────────────────────────────────────────────────┐
  │ feishu-bot.sendReviewCard  ← Phase 2 改造                 │
  │   Phase 2: 仅展示 pending 提案（无按钮）                   │
  │   Phase 3: 每个 pending 提案加 [确认替换][拒绝] 按钮        │
  └──────────────────────┬───────────────────────────────────┘
                         │ 用户点击按钮（Phase 3）
                         ▼
              ┌──────────────────────────┐
              │ scripts/                 │
              │ feishu-callback-server.js│  ← Phase 3 新增（独立常驻服务）
              │  - 签名校验              │
              │  - approve → updateLocator│
              │  - reject  → 标记         │
              └────────────┬─────────────┘
                           │ Phase 4（可选）
                           ▼
              ┌──────────────────────────┐
              │ git branch/commit/push   │
              │ + CNB API 建 PR          │
              └──────────────────────────┘
```

---

## 4. 文件清单

### 新增

| 路径 | 期 | 职责 |
|---|---|---|
| `locator-store.json` | P1 | locatorKey → locator 字符串映射，提交进 git |
| `utils/locator-repository.ts` | P1 | `getLocator(key)` / `updateLocator(key, newLocator)`，读写 `locator-store.json` |
| `utils/healer-proposal-store.ts` | P2 | 提案 CRUD：`addProposal` / `readProposals` / `updateProposalStatus`，去重逻辑 |
| `scripts/feishu-callback-server.js` | P3 | 独立常驻 HTTP 服务，接收飞书卡片按钮回调，校验签名，改 `locator-store.json` |
| `tests/locator-store.spec.ts` | P1 | `locator-repository` 单测 |
| `tests/healer-proposal.spec.ts` | P2 | 提案去重 / 状态流转单测 |
| `tests/fixtures/feishu-callback-fixture.js` | P3 | 回调服务签名校验单测（mock HTTP） |

### 修改

| 路径 | 期 | 改动 |
|---|---|---|
| `skills/self-healing-locator/contract.ts` | P1 | `HealInput` 增加可选 `locatorKey?: string` 字段（不破坏现有调用） |
| `utils/ai-healer.ts` | P1 | 新增 `aiClickByKey/aiAssertByKey/aiFillByKey/aiLocateByKey` 导出；新增内部 `healWithResult()` 返回 `{healed, output}`，让 ByKey 包装能知道是否发生过自愈以写提案 |
| `playwright.global-setup.ts` | P2 | 加 `healCache.clear()`，让缓存退化为纯运行内（见 §2 第 3 点） |
| `utils/feishu-bot.ts` | P2/P3 | P2：新增 `sendReviewCard(opts)`；P3：卡片元素加 `value.action` 回调按钮 |
| `reporters/feishu-reporter.ts` | P2 | `onEnd` 里若有 pending 提案，调 `sendReviewCard` 替代/补充 `sendCaseSummaryNotification` |
| `tests/ai-case.spec.ts` | P1 | 改用 `aiClickByKey('manualConfirmMenu', ...)` / `aiAssertByKey('batchConfirmButton', ...)` |
| `package.json` | P3 | 加 `"feishu:callback": "node scripts/feishu-callback-server.js"` 脚本（无新依赖） |
| `.gitignore` | P2 | 确认 `test-results/healer-proposals.json` 已被 `test-results/` 覆盖（无需新增条目，仅核对） |

### 不动

`utils/heal-event-bus.ts`、`utils/heal-cache.ts`、`utils/quality-gate.ts`、`utils/openai-client.ts`、`utils/capture-state.ts`、`utils/healer-collector.ts`、`playwright.config.ts`、`tests/healer.spec.ts`、`tests/healer-integration.spec.ts`、`Jenkinsfile`。

---

## 5. 分期任务

### Phase 1 — Locator Store + ByKey API  ✅ 已完成 (2026-06-17)

**目标**：定位器集中到 `locator-store.json`，spec 只用 key。不动飞书、不动缓存语义。

- [x] **P1-1** 扩展契约：`skills/self-healing-locator/contract.ts` 的 `HealInput` 加 `locatorKey?: string`。不破坏现有 `aiClick` 调用（字段可选）。
- [x] **P1-2** 新建 `locator-store.json`：
  ```json
  {
    "manualConfirmMenu": ".ant-menu-item:has-text(\"人工确认\")",
    "batchConfirmButton": "text=批量确认",
    "projectSearchInput": "input[placeholder=\"请输入项目名称\"]",
    "projectCreateButton": "text=新增项目"
  }
  ```
- [x] **P1-3** 新建 `utils/locator-repository.ts`：`getLocator` / `updateLocator` / `listLocatorKeys` / `getStoreFilePath`，支持 `LOCATOR_STORE_PATH` 覆盖。
- [x] **P1-4** `utils/ai-healer.ts` 新增 4 个 ByKey 导出：`aiClickByKey` / `aiAssertByKey` / `aiFillByKey` / `aiLocateByKey`，Phase 1 为纯委托（调用现有 `aiXxx`），不动现有 `heal()` / `aiClick` 等签名与行为。`healWithResult` 推迟到 Phase 2（写提案时才需要）。
- [x] **P1-5** 迁移 `tests/ai-case.spec.ts`：3 个用例全部改用 ByKey；2 个 `test.fixme` 保持 fixme（D5 默认：仅迁移不启用）。
- [x] **P1-6** 新建 `tests/locator-store.spec.ts`：8 个用例覆盖命中/未命中/写回/禁止新增 key/空值/store 文件缺失/路径覆盖。
- [x] **P1-7** 验证：`npx playwright test` 全量 **16 passed, 9 skipped**（9 skipped = `RUN_INTEGRATION` gated 集成测试 + 2 个 `test.fixmo`），零回归。

**Phase 1 验收**（均满足）：
1. `locator-store.json` 已提交，spec 里无任何硬编码 locator 字符串。
2. `npx playwright test` 通过（16 passed）。
3. 故意改坏 `locator-store.json` 里 `manualConfirmMenu` → 跑测试 → 自愈链路正确触发：堆栈 `aiClickByKey → aiClick → heal → callAIForHeal` 完整执行到 AI 客户端层（验证时因无 AI key 在 AI 客户端抛错，但链路已证明打通）。
4. `tests/healer.spec.ts` 全绿（API 兼容，零回归）。

> **Phase 2 注意事项**：`utils/openai-client.ts` 的 mock 钩子是 `setMockOpenAIClient(fn)`（编程式注入），**不读** `HEALER_MOCK_RESPONSE` 环境变量。Phase 2 写提案相关测试时，需在 spec 里 `import { setMockOpenAIClient } from '../utils/openai-client'` 注入 mock，不能靠环境变量。

---

### Phase 2 — Proposal Store + 审核 Reporter  ✅ 已完成 (2026-06-17)

**目标**：AI 自愈成功后，把"原 locator → 新 locator"作为**待审核提案**持久化；测试结束飞书发"待审核"卡片（仅展示，无按钮）。

- [x] **P2-1** 新建 `utils/healer-proposal-store.ts`：`HealProposal` 接口 + `clearProposals` / `addProposal`（按 `locatorKey+oldLocator+newLocator` 去重 pending）/ `readProposals` / `updateProposalStatus`（幂等）/ `getProposalFilePath`。存储 `test-results/healer-proposals.json`，支持 `HEALER_PROPOSAL_PATH` 覆盖。
- [x] **P2-2** `utils/ai-healer.ts`：`heal()` 返回值改为 `HealResult { locator, output, cacheHit }`（现有 `aiXxx` 适配，行为不变）；4 个 `aiXxxByKey` 重写为自带 try-original → heal 流程，成功 `addProposal(pending)`，失败 `addProposal(failed)` 后抛**原始** locator 错误（对齐用户原方案语义）。`recordProposal` 辅助函数 best-effort 写提案，不阻塞测试。
- [x] **P2-3** `playwright.global-setup.ts` 加 `clearProposals()` + `healCache.clear()`：提案每次运行清空；**跨运行缓存清空**（D1 落地），让缓存退化为纯运行内去重，避免 AI locator 跨运行自动应用绕过审核。
- [x] **P2-4** `utils/feishu-bot.ts` 新增 `sendReviewCard(opts)`：复用现有 `sendCard`/`field`/`divMd`/`code`/`escapeMd`/`truncate`/`linkButton` 辅助函数。卡片含概览（total/passed/failed/skipped + pending/failed 数）+ pending 提案详情（elementName/testName/locatorKey/action/oldLocator/newLocator/confidence/reason）+ failed 提案摘要 + 报告链接。Phase 2 无按钮。
- [x] **P2-5** `reporters/feishu-reporter.ts` 的 `onEnd`：读 `readProposals()`，若 `pending > 0` 调 `sendReviewCard`（标题"⚠️ Playwright AI 自愈待审核"，status `warning`），否则维持现有 `sendCaseSummaryNotification`。
- [x] **P2-6** 新建 `tests/healer-proposal.spec.ts`（11 用例）+ `tests/healer-bykey-proposal.spec.ts`（4 用例）：覆盖去重 / pending↔failed 状态 / 幂等流转 / ByKey 成功写 pending / ByKey 失败写 failed 并抛原始错误 / 同 key 二次调用去重 / 原 locator 有效时不写提案。
- [x] **P2-7** 修复 `utils/quality-gate.ts` pre-existing bug：`count()===0` 或 `>1` 时未 early return，继续执行 `isEnabled()`/`textContent()` 对不存在/不唯一元素会死等 actionability timeout。改为 count≠1 直接 return fail。这让"自愈失败"路径不再挂死（之前 aiClickByKey 失败路径会卡 30s）。
- [x] **P2-8** 验证：全量 **31 passed, 9 skipped, 0 failed**；故意改坏 locator-store → ByKey 自愈成功 → `healer-proposals.json` 恰好 1 条 pending（去重生效）。

**Phase 2 验收**（均满足）：
1. 自愈成功后提案文件恰好 1 条 pending（`healer-bykey-proposal.spec.ts` test 1/2 验证去重）。
2. 飞书审核卡片结构正确（`sendReviewCard` 复用现有卡片辅助函数，未配置时 console.log skip）。
3. 第二次运行不再自动复用上次 AI locator（`globalSetup` 的 `healCache.clear()` 已落地，运行内仍去重）。
4. 现有 `healer.spec.ts` / `healer-integration.spec.ts` / `locator-store.spec.ts` 全部不回归。

> **Phase 2 注意事项**：`aiAssert`/`aiAssertByKey` 的自愈触发依赖 `isVisible()` 抛错，但 Playwright 的 `isVisible()` 在元素不存在时返回 `false` 不抛错——这是现有行为，意味着 assert 路径的自愈仅在 strict-mode 违例等场景触发。正常 assert 失败不会自愈。这是 pre-existing 限制，不在本计划修复范围（修复需改 `aiAssert` 用 `expect(locator).toBeVisible()`，会影响 gated 集成测试，留给后续迭代）。

---

### Phase 3 — 飞书交互回调（长连接模式）  ✅ 已完成 (2026-06-17)

**目标**：飞书卡片每个 pending 提案加 [确认替换][拒绝] 按钮；点击后回调服务改 `locator-store.json`。

**实现差异（相对原计划）**：原计划写"纯 Node http + 自校验签名"，实际采用**长连接模式**后：
- **不需要** HTTP server / 公网 URL / `ENCRYPT_KEY` / `VERIFICATION_TOKEN`——签名校验由飞书 SDK 内置
- **必须装** `@larksuiteoapi/node-sdk`（私有 WebSocket 协议，无 SDK 无法实现长连接）+ `tsx`（dev，让 `.js` 脚本加载 `.ts` 模块）
- 卡片回调通过 `EventDispatcher.register({ cardAction: async (evt) => {...} })` 接收，`evt.action.value` 即按钮声明的 value
- approve/reject 后用 `client.im.message.patch` 原地更新卡片（移除按钮、显示结果，防重复点击）
- token 兜底（`HEALER_CALLBACK_TOKEN`）保留作为 SDK 签名之上的额外防线

- [x] **P3-1** 飞书应用配置（**人工操作，待用户在飞书后台完成**）：
  - 应用后台 → 事件与回调 → 事件配置 → 推送方式切"使用长连接接收事件"
  - 事件与回调 → 卡片交互回调 → 同样长连接模式
  - 权限管理开启 `im:message` + 卡片相关权限
  - **不需要** Encrypt Key / Verification Token（长连接模式 SDK 内置签名校验）
  - 可选：设 `HEALER_CALLBACK_TOKEN` 环境变量作为按钮 value 里的共享密钥兜底
- [x] **P3-2** `utils/feishu-bot.ts` 的 `sendReviewCard` 给每个 pending 提案加 `action` 按钮：[✅ 确认替换] / [❌ 拒绝]，`value` 含 `{ action, proposalId, token }`。pending 超过 10 个只展示前 10 个 + note 提示（飞书单卡按钮上限）。
- [x] **P3-3** 新建 `utils/healer-review-actions.ts`（**纯函数，可单测**）：`parseCallbackValue` / `validateCallbackToken` / `approveLocatorProposal` / `rejectLocatorProposal` / `handleReviewCallback`。approve 流程：`updateLocator(key, newLocator)` + `updateProposalStatus(id,'approved')`；reject 只改状态不动 store。幂等：非 pending 状态返"已处理过"。
- [x] **P3-4** 新建 `scripts/feishu-callback-server.js`（长连接，**无 HTTP server**）：用 `@larksuiteoapi/node-sdk` 的 `WSClient` + `EventDispatcher.register({ cardAction })` 接收回调。approve/reject 后用 `client.im.message.patch` 原地更新卡片（移除按钮、显示结果）。复用 `FEISHU_APP_ID`/`FEISHU_APP_SECRET`，支持 `FEISHU_DOMAIN=lark` 国际版。
- [x] **P3-5** `package.json` 加 `"feishu:callback": "tsx scripts/feishu-callback-server.js"` + 装 `@larksuiteoapi/node-sdk`(dep) / `tsx`(devDep)。
- [x] **P3-6** 新建 `tests/healer-review-actions.spec.ts`（19 用例）：parse 校验 / token 开关 / approve 改 store+状态 / reject 不改 store / 幂等 / failed 提案不可批准 / handleReviewCallback 路由 / token 失败拒绝。
- [x] **P3-7** 验证：全量 **50 passed, 9 skipped, 0 failed**；`tsx scripts/feishu-callback-server.js` 加载链路完整（client ready → event-dispatch ready → 等待 card action），假凭据下 SDK 报 invalid appId 但脚本逻辑正确（真凭据会建连成功）。

**Phase 3 验收**（代码部分满足，真机飞书点击待 P3-1 配置后由用户验证）：
1. ✅ token 校验：`HEALER_CALLBACK_TOKEN` 设了则按钮 value.token 必须匹配（19 用例覆盖）；未设则开放模式靠 SDK 签名。
2. ✅ approve 后 `locator-store.json` 对应 key 更新 + proposal 状态 `approved`（test 验证）。
3. ✅ reject 后 proposal 状态 `rejected`，`locator-store.json` 不变（test 验证）。
4. ⏳ 真机点击待用户配飞书长连接 + 真实凭据后验证（P3-1）。
5. ✅ 卡片原地更新逻辑就绪（`client.im.message.patch`，approve 后按钮消失显示结果，防重复点击）。

---

### Phase 4（可选） — Git PR 自动化

**目标**：approve 后不只改本地 `locator-store.json`，而是自动建分支 + 提交 + 推 CNB + 建 PR，让人工合并。

- [ ] **P4-1** 决策：回调服务部署位置必须有 git 仓库写权限。三选一：
  - (a) 回调服务跑在持有仓库 clone 的主机上，直接 shell out `git`。
  - (b) 回调服务无本地仓库，调 CNB REST API（`https://api.cnb.cool`）创建文件 + PR。
  - (c) 不自动化，approve 只改本地文件，人工 `git commit && git push`。
- [ ] **P4-2** 若选 (a)：`scripts/feishu-callback-server.js` 的 approve 分支里：
  ```js
  // 伪代码
  execSync(`git -C ${repoRoot} checkout -b ai-heal/${locatorKey}-${Date.now()}`);
  updateLocator(key, newLocator);  // 改 locator-store.json
  execSync(`git -C ${repoRoot} add locator-store.json`);
  execSync(`git -C ${repoRoot} commit -m "ai-heal: update ${key}"`);
  execSync(`git -C ${repoRoot} push origin HEAD`);
  // 然后调 CNB API 建 PR
  ```
  必须 try-finally 保证 checkout 失败时回滚分支，避免污染主分支。
- [ ] **P4-3** 若选 (b)：用 `cnb-code-commit` skill 或直接 `fetch('https://api.cnb.cool/.../branches', ...)`。需要 CNB token 环境变量 `CNB_TOKEN`。
- [ ] **P4-4** 卡片按钮文案改为"确认替换并提 PR" / "拒绝"，approve 后 toast 带上 PR 链接。
- [ ] **P4-5** Jenkinsfile 加 webhook 触发器（PR 创建时自动重跑测试），形成闭环。

**Phase 4 验收**：
1. 飞书点"确认替换并提 PR" → CNB 出现一个只改 `locator-store.json` 的 PR。
2. PR 描述里带 oldLocator → newLocator diff。
3. PR 合并后 Jenkins 自动重跑，原 locator 不再失效，无自愈事件。

---

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| Phase 2 清缓存后，同运行内同 key 多 case 仍会重复调 AI | 不会：`healCache` 在运行内仍生效（clear 只在 globalSetup 调一次），运行内同 key 第 2 次走 cache hit |
| 飞书卡片按钮回调超 3 秒被飞书判超时 | `locator-store.json` 是本地小文件，同步读写 < 10ms；git 操作（Phase 4）需异步化：先 200 响应，后台 git push |
| 回调服务被人伪造请求篡改 locator | 签名校验 + token 兜底 + 仅监听 `127.0.0.1`/内网，公网入口走反代加 ACL |
| 同一 proposal 被点两次"确认" | `updateProposalStatus` 前检查当前状态，非 `pending` 直接返 toast"已处理过" |
| `locator-store.json` 被并发写坏（回调 + 测试同时写） | 测试只读不写 `locator-store.json`（写的是 `healer-proposals.json`）；只有回调服务写 `locator-store.json`，单写者无竞态 |
| Phase 1 后 `tests/healer.spec.ts` / `healer-integration.spec.ts` 回归 | 这两个文件用的是 `aiClick/aiAssert/selfHeal/HealCache` 内联 API，Phase 1 不改这些导出，仅新增 ByKey，理论上零回归；P1-8 验证 |
| AI 候选 locator 被审核通过但其实不稳 | `healer-proposals.json` 留 `confidence` / `reason` 字段供人参考；审核是人工判断，不自动合并 |
| 缓存清空导致 AI 调用次数/token 成本上升 | 仅当 locator 真失效时才调 AI（正常 case 原 locator 直接通过，不进 heal 流）；成本可接受 |

---

## 7. 全局验收标准（4 期全完成后）

1. `locator-store.json` 是定位器唯一真相源，提交进 git，spec 里零硬编码 locator。
2. 故意改坏 `locator-store.json` 一个 key → 跑测试 → 测试通过（自愈）→ `healer-proposals.json` 1 条 pending。
3. 飞书收到"待审核"卡片，展示 old/new locator + confidence + reason。
4. 飞书点"确认替换" → `locator-store.json` 更新 → toast 成功。
5. 第二次跑测试（不重跑 PR 流程）：原 key 不再失效，无自愈事件，无新提案。
6. 飞书点"拒绝" → `locator-store.json` 不变 → proposal 状态 `rejected`。
7. 无 token 请求被 401 拒绝。
8. `npx playwright test` 全绿，含 `healer.spec.ts` / `healer-integration.spec.ts` / `locator-store.spec.ts` / `healer-proposal.spec.ts`。
9. （Phase 4）点"确认替换并提 PR" → CNB 出现 PR，合并后 Jenkins 自动重跑通过。

---

## 8. 待用户确认的决策点

- [ ] **D1**：Phase 2 是否清空跨运行缓存（`healCache.clear()` in globalSetup）？本计划默认**是**（否则审核可被缓存绕过）。若想保留跨运行缓存作为"软自动修复"，则 proposal 退化为纯审计记录，需重新定义"审核"语义。
- [ ] **D2**：Phase 3 回调服务部署位置？长连接模式（本地友好）/ 独立常驻主机 / Cloudflare Worker 之类。影响 P3-3 实现。
- [ ] **D3**：Phase 4 是否做？若做，选 (a) 本地 git shell / (b) CNB API / (c) 不自动化。
- [ ] **D4**：`locator-store.json` 是否按页面/模块分文件（如 `locators/home.json`、`locators/confirm.json`）？本计划默认单文件，元素多了再拆。
- [ ] **D5**：现有 `tests/ai-case.spec.ts` 里 2 个 `test.fixme` 用例是否在 Phase 1 一并迁移到 ByKey 并启用？还是保持 fixmo 仅迁移不启用？

---

## 9. 执行建议

- Phase 1 可由 1 个 subagent 串行完成（7 个任务，约 2-3 小时），结束跑 `npx playwright test` 验证。
- Phase 2 与 Phase 1 强依赖（ByKey 包装里写提案），仍串行。
- Phase 3 的飞书配置（P3-1）是人工任务，需用户在飞书后台操作；代码部分（P3-2~P3-5）可与 P3-1 并行。
- Phase 4 视 D3 决策，可跳过。

每期结束 commit 一次，commit message 前缀：`feat(locator-review): phase N - ...`。
