# playwright-ai-healer

## 项目介绍

`playwright-ai-healer` 是一个基于 Playwright 的自动化测试自愈实验项目，用于验证在 UI 自动化测试中，当页面元素定位器失效时，是否可以借助 AI 自动分析当前页面 DOM，并生成新的候选定位器，辅助测试脚本继续执行。

本项目主要用于演示以下场景：

* Playwright 脚本执行过程中，原始元素定位器失效；
* 系统自动抓取当前页面上的可见元素信息；
* 调用 AI 模型生成新的候选定位器；
* 使用 AI 生成的新定位器重新执行点击或断言；
* 将自愈触发、自愈失败等结果推送到飞书机器人；
* 支持在 Jenkins 中运行自动化测试，并生成 Playwright HTML 报告。

## 核心能力

### 1. AI 自愈点击

当普通点击失败时，项目会调用 `aiClick` 方法进行自愈处理：

```ts
await aiClick(page, 'text=批量确认', '批量确认按钮');
```

执行逻辑：

1. 优先使用原始定位器执行点击；
2. 如果点击失败，抓取当前页面 DOM 快照；
3. 将失败定位器、目标元素描述、页面元素信息发送给 AI；
4. AI 返回一个新的候选定位器；
5. 使用新定位器重新点击；
6. 将自愈结果推送到飞书。

### 2. AI 自愈断言

当元素断言失败时，项目会调用 `aiAssert` 方法进行自愈处理：

```ts
await aiAssert(page, 'text=批量确认', '批量确认按钮');
```

执行逻辑：

1. 优先使用原始定位器进行可见性断言；
2. 如果断言失败，抓取当前页面 DOM 快照；
3. 调用 AI 生成新的候选定位器；
4. 使用新定位器重新执行断言；
5. 根据结果推送飞书通知。

### 3. 飞书机器人通知

项目集成了飞书机器人通知能力，用于在自愈触发、自愈失败、自愈成功时发送消息。

当前通知采用飞书**交互式卡片**（`msg_type: interactive`）格式，卡片包含：

* 彩色标题头（成功绿色 / 警告橙色 / 失败红色）；
* 分栏字段展示：元素描述、动作、原始定位器、AI 修复定位器、置信度、修复原因；
* 错误详情以代码块展示，便于复制排查；
* 页面地址、耗时、测试用例、时间等上下文信息；
* 「查看 Jenkins」等跳转按钮，一键直达构建详情。

运行结束还会由 `reporters/feishu-reporter.ts` 汇总发送一张总览卡片，包含测试总数 / 通过 / 失败 / 跳过、自愈触发 / 成功 / 失败统计、失败用例明细、AI 自愈明细，以及「查看完整测试报告」按钮。

### 4. Jenkins 自动化执行

项目提供了 `Jenkinsfile`，用于在 Jenkins 中执行 Playwright 自动化测试。

Jenkins 执行流程包括：

1. 拉取代码；
2. 安装依赖；
3. 执行 Playwright 测试；
4. 发布 Playwright HTML 测试报告。

Jenkins 当前使用的 Docker 镜像为：

```text
mcr.microsoft.com/playwright:v1.61.0-noble
```

## 项目结构

```text
playwright-ai-healer
├── tests/                       # Playwright 测试用例目录
│   ├── ai-case.spec.ts          # 业务用例（接入 AI 自愈）
│   ├── healer.spec.ts           # 自愈能力单元测试
│   ├── healer-integration.spec.ts
│   └── fixtures/                # 测试夹具（如 broken-page.html）
├── utils/                       # 工具与核心能力封装
│   ├── ai-healer.ts             # AI 自愈点击/断言封装
│   ├── feishu-bot.ts            # 飞书机器人卡片通知封装
│   ├── capture-state.ts         # 页面状态抓取
│   ├── heal-cache.ts            # 自愈结果缓存
│   ├── heal-event-bus.ts        # 自愈事件总线
│   ├── healer-collector.ts      # 自愈事件采集
│   ├── openai-client.ts         # AI 模型客户端
│   └── quality-gate.ts          # 自愈质量门禁
├── reporters/
│   └── feishu-reporter.ts       # Playwright 自定义 Reporter，运行结束汇总推送飞书
├── skills/self-healing-locator/ # 自愈定位器 Skill 契约与说明
├── scripts/                     # 辅助脚本（自愈自测、缓存打印等）
├── playwright.config.ts         # Playwright 配置文件
├── playwright.global-setup.ts   # 全局初始化（如初始化飞书机器人订阅）
├── playwright.global-teardown.ts
├── Jenkinsfile                  # Jenkins 流水线配置（拉镜像方式）
├── .cnb.yml                     # CNB 原生流水线配置（更快、自带缓存，推荐）
├── package.json                 # 项目依赖与脚本配置
├── .env                         # 本地环境变量配置（不入库）
└── README.md                    # 项目说明文档
```

## 本地运行

### 1. 安装 Node.js

建议使用 Node.js 18 或以上版本。

查看本地 Node.js 版本：

```bash
node -v
npm -v
```

### 2. 安装项目依赖

进入项目目录：

```bash
cd playwright-ai-healer
```

安装依赖：

```bash
npm install
```

如果项目已有 `package-lock.json`，也可以使用：

```bash
npm ci
```

### 3. 安装 Playwright 浏览器

安装 Chromium 浏览器：

```bash
npx playwright install chromium
```

如果希望安装 Playwright 支持的全部浏览器，可以执行：

```bash
npx playwright install
```

### 4. 配置本地环境变量

在项目根目录下新建 `.env` 文件：

```bash
touch .env
```

Windows 可以直接在项目根目录中新建 `.env` 文件。

`.env` 示例：

```env
DEEPSEEK_API_KEY=你的 DeepSeek API Key

FEISHU_APP_ID=你的飞书应用 App ID
FEISHU_APP_SECRET=你的飞书应用 App Secret
FEISHU_CHAT_ID=你的飞书群聊 Chat ID
```

说明：

* `DEEPSEEK_API_KEY`：用于调用 AI 模型生成候选定位器；
* `FEISHU_APP_ID`：飞书应用 ID；
* `FEISHU_APP_SECRET`：飞书应用密钥；
* `FEISHU_CHAT_ID`：飞书通知发送到的群聊 ID。

如果暂时不配置飞书相关变量，项目会跳过飞书通知，不影响本地测试执行。

### 5. 执行自动化测试

执行全部测试：

```bash
npx playwright test
```

指定使用 Chromium 执行：

```bash
npx playwright test --project=chromium
```

以有头模式运行，方便观察浏览器操作过程：

```bash
npx playwright test --headed
```

调试模式运行：

```bash
npx playwright test --debug
```

执行完成后查看 HTML 报告：

```bash
npx playwright show-report
```

## 推荐 package.json 脚本

可以在 `package.json` 中增加以下脚本，方便本地运行：

```json
{
  "scripts": {
    "test": "playwright test",
    "test:headed": "playwright test --headed",
    "test:debug": "playwright test --debug",
    "test:report": "playwright show-report"
  }
}
```

之后可以使用：

```bash
npm run test
npm run test:headed
npm run test:debug
npm run test:report
```

## Playwright 配置说明

当前 `playwright.config.ts` 配置如下：

* 测试目录：`./tests`
* 浏览器项目：`chromium`
* 报告类型：HTML Report
* 失败截图：仅失败时截图
* Trace：首次重试时开启
* CI 环境下失败重试次数：2 次
* CI 环境下 Worker 数量：1

这意味着：

* 本地运行时默认不重试；
* Jenkins 中运行时会自动重试失败用例；
* 失败后可以通过 Playwright 报告查看截图、Trace 和执行过程。

## Jenkins 运行说明

Jenkins 中需要提前配置以下凭据：

```text
DEEPSEEK_API_KEY
FEISHU_APP_ID
FEISHU_APP_SECRET
FEISHU_CHAT_ID
```

流水线执行时会自动注入这些环境变量。

Jenkins 执行流程：

```text
Checkout
  ↓
Install Dependencies
  ↓
Run Tests
  ↓
Publish Playwright Report
```

执行命令为：

```bash
npm ci
npm run test:ci      # 等价于 NODE_OPTIONS='--require ts-node/register' playwright test
```

测试完成后，Jenkins 会发布 `playwright-report/index.html` 作为 HTML 报告。

### 更快的方式：CNB 原生流水线

仓库根目录已提供 `.cnb.yml`，相比 Jenkins 每次拉镜像起容器的方式更快：

* 直接使用 CNB 托管运行环境，省去宿主机 `docker run` 容器起停开销；
* 通过 `volumes` 自动缓存 `node_modules` 与 npm 下载包，依赖安装近乎秒级；
* Playwright 镜像内置浏览器，无需重复安装。

在仓库「设置 → 环境变量 / 密钥」中配置好 `DEEPSEEK_API_KEY`、`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_CHAT_ID` 后，推送到 `main` 或提交 PR 即可自动触发构建。

## 使用示例

普通 Playwright 写法：

```ts
await page.locator('text=批量确认').click();
await expect(page.locator('text=批量确认')).toBeVisible();
```

接入 AI 自愈后的写法：

```ts
await aiClick(page, 'text=批量确认', '批量确认按钮');
await aiAssert(page, 'text=批量确认', '批量确认按钮');
```

当 `text=批量确认` 失效时，系统会自动尝试通过 AI 生成新的定位器，例如：

```ts
button:has-text("批量确认")
```

并重新执行点击或断言。

## 适用场景

本项目适合用于以下测试场景：

* 页面文案轻微变化导致定位器失效；
* 前端组件结构变化导致 CSS 定位器失效；
* 自动化脚本需要增强稳定性；
* 希望将 AI 引入测试开发流程；
* 希望在 Jenkins 中观察自动化失败、自愈、通知的完整链路；
* 希望将自愈结果推送到飞书，方便测试团队及时感知问题。

## 注意事项

1. AI 自愈不是替代测试工程师维护脚本，而是辅助定位问题；
2. AI 生成的新定位器需要经过人工审核后再沉淀到正式脚本中；
3. 不建议直接让 AI 自动修改测试代码；
4. 对关键业务流程，仍然建议使用稳定的 `data-testid`；
5. 飞书通知中出现的自愈定位器，应作为候选方案，而不是最终方案；
6. Jenkins 中的自愈结果建议结合 Playwright HTML 报告一起分析。
