# AGENTS.md

> Playwright + AI 自愈定位器实验项目。Agent 必读：本文档只记"读代码读不出来"的硬约束。

## 项目一句话

基于 Playwright + DeepSeek 的 UI 自动化自愈演示。目标站点：`https://ai-case.wiac.xyz/`（Antd 5 风格）。定位器失效时调用 DeepSeek 生成候选 locator，并发飞书卡片通知。

## 关键命令

| 场景 | 命令 |
|---|---|
| 安装依赖 | `npm ci`（CI/干净环境） 或 `npm install`（本地） |
| 安装浏览器 | `npx playwright install chromium` |
| 跑测试 | `npx playwright test` ⚠️ 不是 `npm test` |
| 单 project 跑 | `npx playwright test --project=chromium` |
| 有头调试 | `npx playwright test --headed` / `--debug` |
| 查看报告 | `npx playwright show-report` |

> `package.json` 的 `test` script 是占位 `echo Error && exit 1`，没有 `test:headed` 等快捷脚本。直接用 `npx playwright` 即可，不要加 npm run。

## 运行时环境变量

放在仓库根 `.env`（已在 `.gitignore`，**不要提交**）：

| 变量 | 必需 | 用途 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 是 | 调用 DeepSeek 生成候选定位器（`baseURL=https://api.deepseek.com`，模型 `deepseek-chat`） |
| `OPENAI_API_KEY` | 否 | 兼容回退：若 `DEEPSEEK_API_KEY` 为空则用此 key |
| `FEISHU_APP_ID` | 否 | 飞书自建应用 App ID |
| `FEISHU_APP_SECRET` | 否 | 飞书 App Secret |
| `FEISHU_CHAT_ID` | 否 | 接收自愈通知的群 chat_id |
| `JENKINS_BUILD_URL` | 否 | Jenkins 注入，飞书卡片会带"查看 Jenkins"按钮 |

缺飞书三项时不报错，只 console.log 跳过，不影响测试结果。

Jenkins 凭据：见 `Jenkinsfile`，五个凭据 ID 与上面变量同名（`DEEPSEEK_API_KEY`、`FEISHU_APP_ID/SECRET/CHAT_ID`）。

## 代码结构（实际位置 vs README）

README 项目结构图**已过时**，实际文件都在 `utils/` 下：

```
playwright-ai-healer/
├── utils/
│   ├── ai-healer.ts        # 导出 aiClick / aiAssert —— 核心入口
│   └── feishu-bot.ts       # 飞书通知（tenant_access_token + post 消息）
├── tests/
│   └── ai-case.spec.ts     # 唯一 E2E 规格，import { aiClick, aiAssert } from '../utils/ai-healer'
├── docs/
│   ├── 多 case 的设计方案.md            # 多 case 汇总通知方案
│   └── superpowers/
│       ├── specs/2026-06-16-self-healing-locator-skill-design.md
│       └── plans/2026-06-16-self-healing-locator-skill-impl.md   # 6 组件 Skill 重构计划
├── playwright.config.ts    # chromium only / HTML 报告 / trace on-first-retry
├── Jenkinsfile             # mcr.microsoft.com/playwright:v1.61.0-noble 容器
└── package.json
```

`utils/ai-healer.ts` 与 `utils/feishu-bot.ts` 都引用了 `feishu-bot` 的 `sendHealNotification`；**不要在两个文件里同时实现飞书逻辑**。

## 模块系统 & 语言

- `package.json` `"type": "commonjs"` —— `import` 用 ESM 语法（被 TS/Playwright 编译），但运行时是 CJS；新加 `.ts` 文件不要写 `import.meta`。
- 没有 `tsconfig.json`：项目跟着 `playwright.config.ts` 走，TS 由 Playwright 内置编译器处理。
- 没有 ESLint / Prettier / lint script —— 改完代码后只能靠 `npx playwright test` 验证，不要去找 `npm run lint`。
- 没有 unit test 框架（jest/vitest 都没装），所有验证都通过跑 spec 完成。

## Playwright 配置（`playwright.config.ts` 关键点）

- `testDir: ./tests`，只 1 个 project：`chromium`（Desktop Chrome）。
- `fullyParallel: true`。
- `retries: CI ? 2 : 0` —— 本地默认不重试，Jenkins 才重试。
- `workers: CI ? 1 : undefined`。
- `reporter: 'html'`，报告输出 `playwright-report/`。
- `screenshot: 'only-on-failure'`，`trace: 'on-first-retry'`。
- 失败时到 `playwright-report/index.html` 查截图 + trace。

## AI 自愈执行流（aiClick / aiAssert）

1. 先用 `page.locator(locatorStr).click({ timeout: 5000 })`（或 `expect.toBeVisible`）尝试；
2. 失败 → `page.evaluate` 抓 `button / a / [role=button] / .ant-menu-item / span` 等可见元素快照（最多 100 个）；
3. 把 `originalLocator + description + DOM 快照` 发给 DeepSeek（`deepseek-chat`）；
4. AI 返回的字符串直接当新 locator 再次 `click`/`toBeVisible`；
5. 成功 → 飞书 `status: warning` 通知"自愈触发"；失败 → 飞书 `status: error` 通知"自愈失败"，并 re-throw 原 Playwright 错误。

> AI 返回的 locator **不持久化、不回写到测试代码**，只在本次运行内用一次。沉淀工作由人审核后手动改 spec。

## 飞书消息格式（`utils/feishu-bot.ts` 内部约定）

- 端点：`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id`
- `tenant_access_token` 走 `auth/v3/tenant_access_token/internal`，模块内缓存（提前 300s 过期）。
- `msg_type: 'post'`，标题 + 多行 text（不是 interactive card）。`description / originalLocator / healedLocator / errorDetail / pageUrl` 五行固定结构。
- 状态映射：`info→success`、`warning→warning`、`error→error`。

## 设计 & 重构计划（**未实现**）

`docs/superpowers/` 下两份文档描述了一个 6 组件 Skill 重构（事件总线 + 文件缓存 + Quality Gate + 4 节点飞书 START/HEAL_SUCCESS/HEAL_FAIL/END + globalSetup/globalTeardown）。**当前 main 分支只实现了 60%**，没有 `utils/heal-event-bus.ts` / `utils/heal-cache.ts` / `utils/quality-gate.ts` / `skills/` 目录。改之前先读 `specs/...-design.md` §6 确认新 API 形态；**别按 spec 直接动 `utils/ai-healer.ts`**，会破坏现有 spec 导入。

## 已知坏状态（工作树）

- `utils/ai-healer.ts` 当前未提交的修改**把它替换成了飞书卡片代码的副本**（与 `utils/feishu-bot.ts` 重复），**丢失了 `aiClick` / `aiAssert` 导出**。
- 这意味着 `tests/ai-case.spec.ts` 当前 `import { aiClick, aiAssert } from '../utils/ai-healer'` 会失败、`npx playwright test` 也跑不起来。
- 处理方式：开始任何新工作前 `git diff utils/ai-healer.ts` 看一眼；若改动仍在，**先 `git restore utils/ai-healer.ts` 回到 HEAD**，或确认是用户主动的 in-progress 重构。
- 另：未跟踪的 `scripts/push-to-cnb.ps1` 是手动 push 辅助脚本（不是构建工具链的一部分），与 CI 无关。

## 提交与远程

- 远程：默认 `origin` 指向 `https://cnb.cool/ImAcaiy/playwright-ai-healer.git`（见 `scripts/push-to-cnb.ps1`），不是 GitHub。
- `git push` 时 credential helper 走 `store`，token 在 `~/.git-credentials`。
- Jenkinsfile 里的 `credentials('...')` 是 Jenkins 凭据 ID，不是 git 凭据。

## 不要做的事

- 不要把 `.env` 提交进去（已在 `.gitignore`，但要双确认 `git status`）。
- 不要在 `utils/ai-healer.ts` 和 `utils/feishu-bot.ts` 同时实现飞书逻辑，保持单一来源。
- 不要为这次小项目加 `tsconfig.json` / ESLint / Prettier，会让"直接 `npx playwright test` 跑"这件事变复杂。
- 不要把 AI 生成的 locator 自动写回 spec —— 人工审核后才能沉淀（见 README "注意事项"）。
