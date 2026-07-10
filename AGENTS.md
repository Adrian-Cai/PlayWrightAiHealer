# AGENTS.md

> Playwright + AI 自愈定位器 + 人工审核闭环。Agent 必读：本文档只记"读代码读不出来"的硬约束。
> 最后更新：2026-06-18（Phase 1-3 已提交，commit bb77db7）

## 项目一句话

基于 Playwright + DeepSeek 的 UI 自动化自愈演示。目标站点：`https://ai-case.wiac.xyz/`（Antd 5 风格）。定位器失效时调用 AI 生成候选 locator → 测试结束后飞书发"待审核"卡片 → 人工点"确认替换" → 只改 `locator-store.json`，AI 永远不碰测试代码。

## 关键命令

| 场景 | 命令 |
|---|---|
| 安装依赖 | `npm ci`（CI） 或 `npm install`（本地） |
| 安装浏览器 | `npx playwright install chromium` |
| 跑测试 | `npx playwright test` ✅ `package.json` 的 `test` script 已是 `playwright test` |
| 单 spec 跑 | `npx playwright test tests/locator-store.spec.ts` |
| 有头调试 | `npx playwright test --headed` / `--debug` |
| 查看报告 | `npx playwright show-report` |
| 启动飞书回调服务 | `npm run feishu:callback`（长连接模式，需飞书凭据） |
| 本地模拟审核 | `npx tsx scripts/simulate-callback.ts list` / `approve <id>` / `reject <id>` |

## 运行时环境变量

放仓库根 `.env`（已在 `.gitignore`，**不要提交**）：

| 变量 | 必需 | 用途 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 是 | AI 生成候选定位器（`baseURL=https://api.deepseek.com`，模型 `deepseek-chat`） |
| `OPENAI_API_KEY` | 否 | 兼容回退 |
| `FEISHU_APP_ID` | 否 | 飞书自建应用 App ID |
| `FEISHU_APP_SECRET` | 否 | 飞书 App Secret |
| `FEISHU_CHAT_ID` | 否 | 接收测试结果汇总卡的群 chat_id |
| `FEISHU_REVIEWER_OPEN_ID` | 否 | 接收 Locator 审批卡的负责人 open_id（私聊） |
| `HEALER_CALLBACK_TOKEN` | 否 | 卡片按钮回调的共享密钥兜底（长连接 SDK 已做签名校验，这是额外防线） |
| `FEISHU_DOMAIN` | 否 | `lark`（国际版）；不设默认飞书国内 |
| `JENKINS_BUILD_URL` | 否 | Jenkins 注入，飞书卡片带"查看 Jenkins"按钮 |
| `FEISHU_SEND_HEAL_EVENTS` | 否 | 设为 `true` 才逐条发送自愈过程；默认只归档进测试报告 |

缺 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_CHAT_ID` 时跳过群汇总；缺 `FEISHU_REVIEWER_OPEN_ID` 时跳过审批私聊，均只 console.log。`.env` 当前**不存在**，真机飞书验证需先创建。

## 代码结构

```
playwright-ai-healer/
├── locator-store.json              # 定位器唯一真相源（key→locator），提交进 git
├── utils/
│   ├── ai-healer.ts                # 核心：heal() + aiClick/aiAssert/aiFill/aiLocate + ByKey 版本
│   ├── locator-repository.ts       # getLocator/updateLocator（读写 locator-store.json）
│   ├── healer-proposal-store.ts    # 提案 CRUD + 去重 + 幂等状态流转
│   ├── healer-review-actions.ts    # 纯函数审批逻辑（approve/reject/token校验）
│   ├── heal-event-bus.ts           # 事件总线（pub/sub）
│   ├── heal-cache.ts               # 运行内缓存（globalSetup 清空，防跨运行绕过审核）
│   ├── healer-collector.ts         # JSONL 事件收集器
│   ├── quality-gate.ts             # AI 候选校验（confidence/唯一性/可见性）
│   ├── openai-client.ts            # DeepSeek/OpenAI 调用 + setMockOpenAIClient 钩子
│   ├── capture-state.ts            # DOM 快照采集
│   └── feishu-bot.ts               # 飞书卡片发送（sendCard/sendReviewCard/sendCaseSummaryNotification）
├── reporters/
│   └── feishu-reporter.ts          # Playwright reporter，onEnd 发审核/汇总卡片
├── scripts/
│   ├── feishu-callback-server.js   # 飞书长连接回调服务（WSClient + cardAction）
│   └── simulate-callback.ts        # 本地模拟审核（无需飞书凭据）
├── tests/
│   ├── ai-case.spec.ts             # E2E（用 ByKey）
│   ├── healer.spec.ts              # 6 组件单测
│   ├── healer-integration.spec.ts  # 集成测试（RUN_INTEGRATION=1 守门）
│   ├── locator-store.spec.ts       # locator-repository 单测（8）
│   ├── healer-proposal.spec.ts     # 提案存储单测（11）
│   ├── healer-bykey-proposal.spec.ts # ByKey+提案集成（4）
│   └── healer-review-actions.spec.ts # 审批逻辑单测（19）
├── skills/self-healing-locator/
│   ├── contract.ts                 # HealInput/HealOutput/HealEvent 等类型
│   └── SKILL.md
├── playwright.config.ts            # chromium / fullyParallel:false / 3 reporter / globalSetup+Teardown
├── playwright.global-setup.ts      # 清 JSONL + 清提案 + 清缓存 + init 订阅
├── playwright.global-teardown.ts   # 日志缓存统计
├── docs/superpowers/
│   ├── specs/2026-06-16-...-design.md       # 6 组件 Skill 设计 spec
│   ├── plans/2026-06-16-...-impl.md          # 6 组件实现计划（已完成）
│   └── plans/2026-06-17-locator-review-system-impl.md  # 人工审核闭环计划（Phase 1-3 已完成）
└── package.json                    # commonjs / tsx(dev) / @larksuiteoapi/node-sdk(dep)
```

## 模块系统 & 语言

- `package.json` `"type": "commonjs"` —— `import` 用 ESM 语法（TS/Playwright 编译），运行时 CJS；新 `.ts` 不要写 `import.meta`。
- 没有 `tsconfig.json`：TS 由 Playwright 内置编译器处理。`tsx` 仅用于 `scripts/` 下的独立脚本（回调服务、模拟工具）。
- 没有 ESLint / Prettier —— 只靠 `npx playwright test` 验证。
- `feishu-bot.ts` 有 3 个 pre-existing `process` lint 报错（无 @types/node），运行时正常，**不要管**。

## Playwright 配置（`playwright.config.ts`）

- `testDir: ./tests`，1 个 project：`chromium`。
- `fullyParallel: false`（非 true！避免并发写 healer-proposals.json 竞态）。
- `retries: CI ? 2 : 0`，`workers: CI ? 1 : undefined`。
- `reporter: [['list'], ['html'], ['./reporters/feishu-reporter.ts']]`（3 个 reporter）。
- `globalSetup` / `globalTeardown` 已接。
- `timeout: 30000`（给 AI 调用留时间）。

## AI 自愈执行流

### 6 组件管线（`heal()` in `ai-healer.ts`）

1. `healCache.get()` 查运行内缓存 → 命中直接返回
2. `capturePageState()` 抓 DOM 快照（ARIA + 可见元素 + 文档树）
3. `callAIForHeal()` 调 DeepSeek/OpenAI（JSON mode，返回 `{locator, strategy, confidence, reason}`）
4. `validateHeal()` Quality Gate：confidence≥0.6 + count==1 + 可见 + 文本匹配；**count≠1 直接 early return fail**（避免对不存在元素死等）
5. 成功 → `healCache.set()` + emit `HEAL_SUCCESS`；失败 → emit `HEAL_FAILED` + 抛错

事件经 `healEventBus` 分发到 `healer-collector`（写 JSONL）和 `feishu-bot`（发卡片）。

### ByKey 包装（Phase 1-2，推荐用法）

```ts
// spec 里用 key，不写死 locator
await aiClickByKey(page, 'manualConfirmMenu', '人工确认菜单项', testInfo);
await aiAssertByKey(page, 'batchConfirmButton', '批量确认按钮', testInfo);
```

ByKey 内部：`getLocator(key)` → 尝试原 locator → 失败走 `heal()` → 成功 `addProposal({status:'pending'})` → 失败 `addProposal({status:'failed'})` + 抛原始 locator 错误。

### 人工审核闭环（Phase 1-3）

```
原 locator 失败 → AI 生成候选 → Quality Gate 验证 → 验证通过写 pending 提案
→ 所有 case 跑完 → reporter 读提案 → 飞书发"待审核"卡片（带 [确认替换][拒绝] 按钮）
→ 用户点按钮 → 长连接回调服务 → approve 改 locator-store.json / reject 只改状态
→ 下次跑测试用新 locator
```

**关键设计决策**：
- `globalSetup` 里 `healCache.clear()` —— 跨运行缓存清空，防 AI locator 绕过审核；运行内仍去重。
- 提案按 `locatorKey+oldLocator+newLocator` 去重，多 case 同 key 只产 1 条。
- `locator-store.json` 是定位器唯一真相源，提交进 git；`healer-proposals.json` 在 `test-results/`（gitignored）。
- 飞书用长连接模式（`@larksuiteoapi/node-sdk` 的 `WSClient`），无需公网 URL；签名校验 SDK 内置。

## 飞书消息

- 端点：`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type={chat_id|open_id}`
- `tenant_access_token` 走 `auth/v3/tenant_access_token/internal`，模块内缓存（提前 300s 过期）。
- 用 **interactive card**（不是 post）：`sendCard()` 统一封装，带重试 + 401 token 失效自动重取。
- `sendCaseSummaryNotification()`：每轮测试都向 `FEISHU_CHAT_ID` 发送无操作按钮的简洁汇总卡。
- `sendReviewCard()`：有 pending 提案时向 `FEISHU_REVIEWER_OPEN_ID` 私聊发送审核卡片，每个提案带 [✅ 确认替换][❌ 拒绝] 按钮，`value` 含 `{action, proposalId, token}`。
- 自愈过程默认只写入 `test-results/ai-healer-events.jsonl` 测试报告产物，不推送飞书。
- 卡片辅助函数：`field`/`divMd`/`hr`/`code`/`escapeMd`/`escapeMdInline`/`truncate`/`linkButton`。

## 测试 mock

- `setMockOpenAIClient(fn)` 注入 mock AI（编程式，**不读** `HEALER_MOCK_RESPONSE` 环境变量）。
- 集成测试用 `RUN_INTEGRATION=1` 守门。
- `aiAssert`/`aiAssertByKey` 的自愈触发依赖 `isVisible()` 抛错，但 Playwright 的 `isVisible()` 元素不存在时返回 `false` 不抛——assert 路径自愈仅在 strict-mode 违例等场景触发。这是 pre-existing 限制。

## 已知问题

- `tests/healer.spec.ts` 的 `new HealCache(300000, ':memory:')` 会把 `:memory:` 当文件名落盘，产生一个名为 `:memory:` 的文件（已 .gitignore 忽略不了因为不是标准名）。跑完测试后手动删 `rm -- :memory:`。
- `feishu-bot.ts` 有 3 个 pre-existing `process` lint 报错（无 @types/node），运行时正常。

## 当前状态（2026-06-18）

- **Phase 1-3 已完成并提交**（commit bb77db7，20 files, +2786/-57）。
- **全量测试：50 passed, 9 skipped, 0 failed**（9 skipped = `RUN_INTEGRATION` gated 集成测试 7 + `test.fixme` 2）。
- 6 组件架构 100% 实现（非 AGENTS.md 旧版说的 60%）。
- 旧的"坏状态"（ai-healer.ts 被替换成 feishu-bot 副本）**已修复**。
- 工作区干净，未推送到远程。

### 待办（优先级降序）

1. **真机飞书验证**：配 `.env`（FEISHU_APP_ID/SECRET/CHAT_ID + DEEPSEEK_API_KEY）→ 改坏 locator → 跑测试 → 启 `npm run feishu:callback` → 飞书点按钮验证。
2. **Phase 4（可选）**：approve 后自动 git 建分支 + 推 CNB + 创 PR。计划见 `docs/superpowers/plans/2026-06-17-locator-review-system-impl.md` §5 Phase 4。
3. **推送到远程**：`git push origin main`（远程 `https://cnb.cool/ImAcaiy/playwright-ai-healer.git`）。

## 不要做的事

- 不要把 `.env` 提交进去（已在 `.gitignore`）。
- 不要在 `utils/ai-healer.ts` 和 `utils/feishu-bot.ts` 同时实现飞书逻辑。
- 不要加 `tsconfig.json` / ESLint / Prettier。
- 不要把 AI 生成的 locator 直接写回 spec —— 通过 `locator-store.json` + 人工审核闭环沉淀。
- 不要改 `fullyParallel` 为 `true`（并发写提案竞态）。
- 不要按 `docs/superpowers/specs/2026-06-16-...-design.md` 重写 `ai-healer.ts`——6 组件已全部实现，spec 是历史记录。
