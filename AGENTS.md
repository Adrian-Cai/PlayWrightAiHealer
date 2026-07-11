# AGENTS.md

> Playwright + AI 自愈定位器 + 人工审核闭环。Agent 必读：本文只记录影响代码修改、测试验证和交付边界的硬约束。
> 最后更新：2026-07-10，按当前 `codex/healer-core-refactor` 分支代码整理。

## 项目一句话

`playwright-ai-healer` 是一个 Playwright UI 自动化自愈实验项目。目标是：当原始元素定位器失效时，运行时抓取页面状态，调用 AI 生成候选 Locator，通过质量门禁验证后临时重试动作；测试结束后生成待审核 Proposal，由人工在飞书中批准或拒绝，批准后只沉淀到 `locator-store.json`，必要时再创建 CNB PR。

核心边界：AI 只负责“候选定位器”和“运行时救场”，不能直接修改测试代码，也不能绕过人工审核把 Locator 永久写入正式资产。

## 当前架构分层

```text
tests/*.spec.ts
  → utils/ai-healer.ts              # Playwright 动作入口：click/assert/fill/locate
  → utils/healer-core.ts            # 自愈核心编排：缓存、页面状态、AI、质量门禁、重试
  → utils/*                         # 缓存、DOM 抓取、AI 客户端、质量门禁、事件、Proposal
  → reporters/feishu-reporter.ts    # 运行结束汇总测试结果与待审核 Proposal
  → scripts/feishu-callback-server.js
  → utils/healer-review-actions.ts  # 人工审核 approve/reject
  → locator-store.json              # 正式 Locator 单一事实源
  → utils/cnb-pr-creator.ts         # 可选：批准后创建 CNB PR
```

三层边界必须保持清晰：

1. `utils/healer-core.ts` 只做自愈主链路编排，不引入飞书、Jenkins、CNB、Reporter 等外围依赖。
2. `utils/ai-healer.ts` 是 Playwright 动作适配层，负责 `clickByKey`、`assertVisibleByKey`、`fillByKey`、`locateByKey` 以及旧导出的兼容入口。
3. 飞书通知、审批回调、CNB PR、Jenkins 报告都属于外围集成，不能参与核心自愈决策。

## 常用命令

| 场景 | 命令 |
|---|---|
| 安装依赖 | `npm ci`（CI 推荐）或 `npm install`（本地） |
| 安装 Chromium | `npx playwright install chromium` |
| 跑全部测试 | `npm run test` 或 `npx playwright test` |
| CI 测试 | `npm run test:ci` |
| Chromium 项目 | `npm run test:chromium` |
| 有头运行 | `npm run test:headed` |
| 调试模式 | `npm run test:debug` |
| 查看 HTML 报告 | `npm run test:report` |
| 启动飞书回调服务 | `npm run feishu:callback` |

当前 `package.json` 使用 CommonJS：`"type": "commonjs"`。TypeScript 由 Playwright/tsx 路径处理；不要因为个人习惯引入新的模块系统改造。

## 环境变量

本地放在仓库根目录 `.env`，不要提交。

| 变量 | 必需 | 用途 |
|---|---:|---|
| `DEEPSEEK_API_KEY` | AI 自愈需要 | 优先使用 DeepSeek 生成候选 Locator |
| `OPENAI_API_KEY` | 否 | DeepSeek 未配置时的兼容回退 |
| `FEISHU_APP_ID` | 飞书需要 | 飞书自建应用 App ID |
| `FEISHU_APP_SECRET` | 飞书需要 | 飞书自建应用 Secret |
| `FEISHU_CHAT_ID` | 否 | 测试汇总卡片发送到群聊 |
| `FEISHU_SUMMARY_CARD_TEMPLATE_ID` | 否 | 测试汇总卡模板 ID；默认 `AAqWfnE72DGps` |
| `FEISHU_REVIEWER_OPEN_ID` | 否 | 待审核 Locator 卡片私聊接收人 |
| `FEISHU_REVIEW_CARD_TEMPLATE_ID` | 否 | 飞书审核卡模板 ID；不配置则使用内置卡片 |
| `FEISHU_SEND_HEAL_EVENTS` | 否 | 设为 `true` 才逐条推送自愈事件；默认只写 JSONL |
| `HEALER_CALLBACK_TOKEN` | 否 | 飞书按钮回调共享密钥，作为 SDK 签名校验之外的额外防线 |
| `FEISHU_DOMAIN` | 否 | `lark` 表示国际版；默认国内飞书 |
| `RUN_ID` | 否 | 写入 Proposal，用于跨系统关联一次运行 |
| `JENKINS_BUILD_URL` | 否 | 写入自愈事件上下文 |
| `BUILD_URL` / `JENKINS_PUBLIC_URL` | 否 | Reporter 拼接 Jenkins 报告链接 |
| `PLAYWRIGHT_REPORT_URL` | 否 | 显式指定 Playwright 报告链接，优先级最高 |
| `LOCATOR_STORE_PATH` | 否 | 覆盖 `locator-store.json` 路径，测试或本地隔离时使用 |
| `HEALER_PROPOSAL_PATH` | 否 | 覆盖 `test-results/healer-proposals.json` 路径 |
| `HEALER_AUTO_PR` | 否 | 设为 `true` 后，人工批准时自动创建 CNB PR |
| `CNB_TOKEN` | `HEALER_AUTO_PR=true` 时必需 | 调用 CNB API 创建 Pull Request |

缺少飞书相关变量时，应降级为 console 日志或跳过飞书发送，不应影响本地测试主流程。缺少 AI Key 时，真实自愈调用会失败；单测应使用 mock。

## 关键文件职责

```text
locator-store.json
  正式 Locator 单一事实源。测试用例通过 key 引用，不要在新用例里散落硬编码 locator。

utils/locator-repository.ts
  getLocator/updateLocator/listLocatorKeys。updateLocator 只能更新已存在 key，避免回调服务偷偷引入新 key。

utils/ai-healer.ts
  Playwright 动作入口。先执行原 Locator，失败后调用 healLocator；ByKey 成功/失败都会记录 Proposal。

utils/healer-core.ts
  自愈核心编排。负责事件 ID、缓存命中、页面状态抓取、AI 候选、质量门禁、最终动作重试和事件发布。

utils/capture-state.ts
  从当前页面抓取 ARIA 元素、可见交互元素、简化 DOM 树、可见错误信息，控制元素数量避免 token 膨胀。

utils/openai-client.ts
  AI 客户端。优先 DeepSeek，回退 OpenAI；JSON mode；提供 setMockOpenAIClient 用于测试。

utils/quality-gate.ts
  AI 候选校验。包含 confidence 阈值、唯一性、可见性、文本一致性、enabled/editable 等动作相关检查。

utils/heal-cache.ts
  自愈结果缓存。globalSetup 会清空，防止跨运行缓存绕过人工审核；运行内可以减少重复 AI 调用。

utils/heal-event-bus.ts
  自愈事件总线。核心只发布事件，不直接关心消费者。

utils/healer-collector.ts
  订阅事件总线，写入 `test-results/ai-healer-events.jsonl`。

utils/healer-proposal-store.ts
  写入待审核 Proposal。pending 表示 AI 自愈成功待审核，failed 表示自愈失败留痕。

utils/healer-review-actions.ts
  审批纯逻辑。校验 token，approve 时更新 `locator-store.json`，reject 只改 Proposal 状态。

scripts/feishu-callback-server.js
  飞书长连接回调服务。接收卡片按钮动作，调用审核逻辑，必要时触发 CNB PR 创建。

utils/cnb-pr-creator.ts
  Phase 4 外围集成。批准后创建分支、提交 `locator-store.json`、推送并创建 CNB PR。默认不启用。

reporters/feishu-reporter.ts
  Playwright Reporter。onEnd 聚合测试结果、自愈事件和 Proposal，发送测试汇总卡与审核卡。

playwright.global-setup.ts
  每次运行前清空 JSONL、Proposal、缓存，并初始化事件采集器与飞书订阅。

playwright.config.ts
  Playwright 配置。不要随意改并发、Reporter、globalSetup/globalTeardown。
```

## 运行时自愈流程

```text
1. 测试用例调用 clickByKey/assertVisibleByKey/fillByKey/locateByKey
2. ai-healer.ts 通过 locatorKey 从 locator-store.json 读取原 Locator
3. 先执行原 Locator
4. 原 Locator 失败后进入 healer-core.ts
5. 查询运行内缓存
6. 缓存未命中或缓存校验失败时，capturePageState 抓取页面状态
7. callAIForHeal 生成候选 Locator
8. validateHeal 执行质量门禁
9. 校验通过后使用候选 Locator 重试原动作
10. 重试成功后写运行内缓存、发布 HEAL_SUCCESS、记录 pending Proposal
11. Reporter 在 onEnd 读取事件与 Proposal，发送飞书汇总/审核卡
12. 人工 approve 后更新 locator-store.json；reject 只更新 Proposal 状态
13. HEALER_AUTO_PR=true 时，approve 后可创建 CNB PR
```

失败处理约定：

- AI 生成的候选 Locator 没通过质量门禁时，必须抛错并记录失败事件。
- ByKey 自愈失败时，`recordProposal(..., null, errorDetail)` 应记录 failed Proposal，便于后续审计。
- `throwWithHealContext` 应保留原始 Locator 失败信息和自愈失败信息，不能只抛 AI 错误。

## Quality Gate 规则

修改 `utils/quality-gate.ts` 时必须保持以下底线：

- `confidence < 0.6` 视为失败。
- 候选 Locator 必须匹配且只匹配 1 个元素。
- 匹配 0 个或多个时应尽早返回失败，避免后续可见性/文本检查悬挂。
- `assert` 携带 `expectedText` 时必须校验文本包含关系。
- `click`、`locate`、`assert` 至少要校验可见性。
- `click` 必须校验 enabled。
- `fill` 必须校验 editable。

不要为了让测试“看起来通过”而降低这些门槛。

## Locator 维护规则

推荐写法：

```ts
await clickByKey(page, 'manualConfirmMenu', '人工确认菜单项', testInfo);
await assertVisibleByKey(page, 'batchConfirmButton', '批量确认按钮', testInfo);
```

兼容旧写法仍可存在，但新用例优先使用 key：

```ts
await aiClick(page, 'text=批量确认', '批量确认按钮', testInfo);
await aiAssert(page, 'text=批量确认', '批量确认按钮', testInfo);
```

规则：

- 新增稳定业务元素时，优先把 Locator 加到 `locator-store.json`，再在 spec 中引用 key。
- `locator-store.json` 是正式资产，应提交进 git。
- `test-results/healer-proposals.json` 是运行产物，不应提交。
- AI 候选 Locator 只能作为 Proposal，人工确认后才可沉淀。
- 对关键业务流程，优先推动前端补 `data-testid`，不要依赖脆弱 class、动态 id 或深层 XPath。

## 飞书审核闭环

审核链路：

```text
Reporter 发现 pending Proposal
  → sendReviewCard 私聊审核人
  → 审核人点击确认/拒绝
  → feishu-callback-server.js 接收 card.action.trigger
  → parseCallbackValue + handleReviewCallback
  → approveLocatorProposal / rejectLocatorProposal
  → approve 更新 locator-store.json，reject 不改 locator-store.json
  → HEALER_AUTO_PR=true 时 createHealPR
```

注意：

- 飞书回调使用长连接模式，无需公网 HTTP 回调地址。
- 卡片按钮 value 中包含 `{ action, proposalId, token }`。
- `HEALER_CALLBACK_TOKEN` 未配置时依赖 SDK 签名校验；生产验证建议配置。
- 回调服务会先持久化审核结果，再异步处理回复消息和 PR 创建，避免卡片回调超时。
- PATCH 卡片刷新可能不稳定，所以代码会额外发回复消息作为可靠反馈。

## CNB PR 创建规则

`HEALER_AUTO_PR` 默认不是 `true`，所以自动 PR 默认关闭。

开启条件：

```env
HEALER_AUTO_PR=true
CNB_TOKEN=...
```

行为：

```text
approveLocatorProposal 已更新 locator-store.json
  → createHealPR
  → git checkout -b ai-heal/{locatorKey}-{timestamp}
  → git add locator-store.json
  → git commit
  → git push origin HEAD
  → POST CNB Pull Request API
  → checkout 回原分支
```

约束：

- 只提交 `locator-store.json`。
- PR body 要包含 old/new locator、置信度、原因、测试用例、页面。
- 创建 PR 失败不能回滚人工审核状态，但要在飞书回复中提示手动提交。
- 不要把自动 PR 逻辑塞进 `healer-core.ts`。

## Playwright 配置约束

当前配置要点：

- `testDir: './tests'`
- `fullyParallel: false`
- CI 下 `retries: 2`、`workers: 1`
- Reporter：`list`、`html`、`./reporters/feishu-reporter.ts`
- `globalSetup` 和 `globalTeardown` 已接入
- 单测超时 30 秒
- 失败截图：`only-on-failure`
- Trace：`on-first-retry`
- 项目：`chromium`

不要把 `fullyParallel` 改成 `true`。当前存在 JSONL、Proposal、缓存等文件写入，随意并发会引入竞态。

## 测试策略

普通改动至少跑：

```bash
npm run test
```

涉及浏览器安装问题时：

```bash
npx playwright install chromium
npm run test:chromium
```

涉及飞书回调时：

```bash
npm run feishu:callback
```

涉及真实 AI 调用时，需要 `.env` 中至少配置 `DEEPSEEK_API_KEY` 或 `OPENAI_API_KEY`。

涉及 PR 创建时，需要本地/CI 环境满足：

- 当前目录是 git 仓库；
- origin 指向 CNB 仓库；
- `CNB_TOKEN` 可用；
- `HEALER_AUTO_PR=true`。

如果本环境不能运行测试，提交说明里必须明确写“未运行测试”以及原因。

## Mock 与集成测试

- 单测优先使用 `setMockOpenAIClient(fn)`，不要在单测里真实调用 AI。
- 不要引入 `HEALER_MOCK_RESPONSE` 这类隐藏环境变量来绕过代码路径。
- 集成测试如有外部依赖，应使用显式守门变量，例如 `RUN_INTEGRATION=1`。
- 测试文件应尽量使用临时 `LOCATOR_STORE_PATH` / `HEALER_PROPOSAL_PATH`，避免污染正式文件。

## 文档维护规则

当修改以下内容时，同步检查 README 与本文档：

- 自愈主流程；
- Locator Store 结构；
- Proposal 状态机；
- 飞书环境变量；
- CNB PR 创建条件；
- Playwright 配置；
- 测试命令。

不要在 AGENTS.md 中写会快速过期的“当前测试通过数量”，除非同一个提交刚刚实际运行并记录了命令。

## 不要做的事

- 不要提交 `.env`、token、App Secret、Chat ID、Open ID、AI Key。
- 不要让 AI 自动改 spec 中的 Locator。
- 不要绕过人工审核直接更新 `locator-store.json`。
- 不要把飞书、Jenkins、CNB、Reporter 逻辑放进 `utils/healer-core.ts`。
- 不要把 `fullyParallel` 改成 `true`。
- 不要为了通过测试降低 Quality Gate 阈值或删除唯一性校验。
- 不要新增全局文件写入而不考虑并发和 globalSetup 清理。
- 不要把 `test-results/` 运行产物提交进仓库。
- 不要无目的引入 tsconfig、ESLint、Prettier 或模块系统大改。
- 不要把历史 `docs/superpowers/specs/*` 当成当前实现强行重写代码；以当前源码为准。

## Agent 修改代码时的默认交付格式

提交或 PR 描述建议包含：

```text
Summary
- 改了什么
- 为什么改
- 影响哪些链路

Validation
- [ ] npm run test
- [ ] npm run test:chromium
- [ ] npm run feishu:callback（如涉及飞书）
- [ ] 手工验证审批卡 approve/reject（如涉及审核）

Risk
- Locator 持久化风险
- 文件写入/并发风险
- 外部凭据/网络依赖风险
```

如果只改文档，Validation 可以写“未运行测试：仅文档更新”。
