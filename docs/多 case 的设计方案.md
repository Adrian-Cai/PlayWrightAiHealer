你现在的问题是：**AI 自愈逻辑写在 `aiAssert / aiClick` 里面，所以它只知道“当前这一个元素失败了”，不知道整个测试任务里有多少个 case 失败。**

所以多组 case 失败时，建议这样设计：

```text
单个 case 执行
  ↓
aiClick / aiAssert 只记录自愈事件
  ↓
Playwright Reporter 统一收集所有 case 结果
  ↓
测试全部跑完后
  ↓
飞书发送一条汇总卡片
```

也就是不要每失败一次就立刻发一条飞书，而是改成：

```text
元素级事件：记录
用例级结果：汇总
飞书通知：测试结束后统一发送
```

---

## 一、推荐的消息设计

多 case 失败时，飞书消息应该长这样：

```text
❌ Playwright 自动化测试完成

项目：playwright-ai-healer
环境：Jenkins
总用例：8
通过：5
失败：2
自愈成功：1
自愈失败：1

失败用例明细：

1. 批量确认按钮断言失败
   用例：人工确认-批量确认按钮校验
   元素：批量确认按钮
   原始定位器：text=批量确认
   AI 修复定位器：button:has-text("批量确认")
   结果：自愈失败
   错误：expect(locator).toBeVisible() failed

2. 项目列表搜索失败
   用例：项目列表-搜索项目
   元素：搜索输入框
   原始定位器：input[placeholder="请输入项目名称"]
   AI 修复定位器：input[placeholder*="项目"]
   结果：自愈成功
```

这样飞书里看到的就不是一堆零散消息，而是一次测试任务的完整结论。

---

## 二、核心改造思路

你现在是这样：

```ts
aiAssert 失败
  ↓
调用 AI
  ↓
马上 sendHealNotification
```

建议改成这样：

```ts
aiAssert 失败
  ↓
调用 AI
  ↓
记录一条自愈事件到本地 JSON 文件
  ↓
继续执行测试

所有测试结束
  ↓
Reporter 读取 JSON 文件
  ↓
统计所有 case 结果
  ↓
发送飞书汇总通知
```

---

## 三、新增一个事件收集器

新增文件：

```text
healer-collector.ts
```

内容如下：

```ts
import fs from 'fs';
import path from 'path';

export type HealEventStatus = 'triggered' | 'success' | 'failed';
export type HealAction = 'click' | 'assert';

export interface HealEvent {
  time: string;
  testName?: string;
  testFile?: string;
  action: HealAction;
  status: HealEventStatus;
  description: string;
  originalLocator: string;
  healedLocator?: string;
  errorDetail?: string;
  pageUrl?: string;
}

const resultDir = path.resolve(process.cwd(), 'test-results');
const eventFile = path.join(resultDir, 'ai-healer-events.jsonl');

export function clearHealEvents() {
  if (!fs.existsSync(resultDir)) {
    fs.mkdirSync(resultDir, { recursive: true });
  }

  fs.writeFileSync(eventFile, '', 'utf-8');
}

export function recordHealEvent(event: Omit<HealEvent, 'time'>) {
  if (!fs.existsSync(resultDir)) {
    fs.mkdirSync(resultDir, { recursive: true });
  }

  const fullEvent: HealEvent = {
    time: new Date().toISOString(),
    ...event,
  };

  fs.appendFileSync(eventFile, JSON.stringify(fullEvent) + '\n', 'utf-8');
}

export function readHealEvents(): HealEvent[] {
  if (!fs.existsSync(eventFile)) {
    return [];
  }

  return fs
    .readFileSync(eventFile, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}
```

这个文件的作用是：
**所有自愈事件不直接发飞书，而是先记录下来。**

---

## 四、改造 aiAssert / aiClick，增加 testInfo

你现在的 `aiAssert` 是：

```ts
export async function aiAssert(page: Page, locatorStr: string, description: string)
```

建议改成：

```ts
import { Page, expect, TestInfo } from '@playwright/test';
import { recordHealEvent } from './healer-collector';

export async function aiAssert(
  page: Page,
  locatorStr: string,
  description: string,
  testInfo?: TestInfo
) {
  try {
    const loc = page.locator(locatorStr);
    await expect(loc).toBeVisible({ timeout: 5000 });

    console.log(`[AI Healer] Assertion passed for "${description}" using original locator.`);
  } catch (error: any) {
    console.warn(`[AI Healer] Assertion failed for "${description}" with locator "${locatorStr}". Attempting self-healing...`);

    const domSnapshot = await page.evaluate(() => {
      const elements = Array.from(
        document.querySelectorAll('button, a, [role="button"], .ant-menu-item, span, th, td, label')
      );

      return elements
        .map(el => {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return null;

          return {
            tag: el.tagName,
            text: el.textContent?.trim().substring(0, 50),
            className: el.className,
            id: el.id,
            role: el.getAttribute('role'),
          };
        })
        .filter(Boolean)
        .slice(0, 100);
    });

    const prompt = `
The Playwright locator "${locatorStr}" failed to assert the element described as "${description}".
Here is a list of interactive/visible elements on the current page:
${JSON.stringify(domSnapshot, null, 2)}

Task: Suggest a new CSS or XPath locator that likely targets the element "${description}".
Rules:
1. Return ONLY the locator string.
2. Prefer robust locators.
3. No explanation, just the string.
`;

    try {
      const completion = await openai.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model: 'deepseek-chat',
      });

      const healedLocator = completion.choices[0].message.content?.trim();

      if (!healedLocator) {
        throw new Error('AI could not suggest a locator.');
      }

      recordHealEvent({
        testName: testInfo?.title,
        testFile: testInfo?.file,
        action: 'assert',
        status: 'triggered',
        description,
        originalLocator: locatorStr,
        healedLocator,
        pageUrl: page.url(),
      });

      const healedLoc = page.locator(healedLocator);
      await expect(healedLoc).toBeVisible({ timeout: 10000 });

      recordHealEvent({
        testName: testInfo?.title,
        testFile: testInfo?.file,
        action: 'assert',
        status: 'success',
        description,
        originalLocator: locatorStr,
        healedLocator,
        pageUrl: page.url(),
      });

      console.log(`[AI Healer] Assertion passed for "${description}" using healed locator.`);
    } catch (aiError: any) {
      recordHealEvent({
        testName: testInfo?.title,
        testFile: testInfo?.file,
        action: 'assert',
        status: 'failed',
        description,
        originalLocator: locatorStr,
        errorDetail: stripAnsi(aiError.message),
        pageUrl: page.url(),
      });

      throw error;
    }
  }
}
```

`aiClick` 也按同样方式改。

重点是这几个字段：

```ts
testName: testInfo?.title
testFile: testInfo?.file
pageUrl: page.url()
```

有了这些字段，飞书通知里才能知道是哪个 case 失败了。

---

## 五、测试用例里这样调用

原来可能是：

```ts
await aiAssert(page, 'text=批量确认', '批量确认按钮');
```

现在改成：

```ts
test('人工确认-批量确认按钮校验', async ({ page }, testInfo) => {
  await page.goto('https://ai-case.wiac.xyz/');

  await aiAssert(page, 'text=批量确认', '批量确认按钮', testInfo);
});
```

多组 case 时，每个 case 都传 `testInfo`：

```ts
test('人工确认-批量确认按钮校验', async ({ page }, testInfo) => {
  await page.goto('https://ai-case.wiac.xyz/');
  await aiAssert(page, 'text=批量确认', '批量确认按钮', testInfo);
});

test('项目列表-搜索项目', async ({ page }, testInfo) => {
  await page.goto('https://ai-case.wiac.xyz/');
  await aiClick(page, 'input[placeholder="请输入项目名称"]', '项目搜索输入框', testInfo);
});

test('项目列表-新增项目', async ({ page }, testInfo) => {
  await page.goto('https://ai-case.wiac.xyz/');
  await aiClick(page, 'text=新增项目', '新增项目按钮', testInfo);
});
```

---

## 六、新增一个 Playwright Reporter

新增文件：

```text
feishu-reporter.ts
```

内容如下：

```ts
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';

import { clearHealEvents, readHealEvents } from './healer-collector';
import { sendCaseSummaryNotification } from './feishu-bot';

interface CaseResult {
  title: string;
  file: string;
  status: string;
  error?: string;
}

class FeishuReporter implements Reporter {
  private total = 0;
  private passed = 0;
  private failed = 0;
  private skipped = 0;
  private caseResults: CaseResult[] = [];

  onBegin(config: FullConfig, suite: Suite) {
    clearHealEvents();
    this.total = suite.allTests().length;
  }

  onTestEnd(test: TestCase, result: TestResult) {
    if (result.status === 'passed') {
      this.passed++;
    }

    if (result.status === 'failed' || result.status === 'timedOut') {
      this.failed++;

      this.caseResults.push({
        title: test.title,
        file: test.location.file,
        status: result.status,
        error: result.error?.message,
      });
    }

    if (result.status === 'skipped') {
      this.skipped++;
    }
  }

  async onEnd(result: FullResult) {
    const healEvents = readHealEvents();

    const healSuccessCount = healEvents.filter(e => e.status === 'success').length;
    const healFailedCount = healEvents.filter(e => e.status === 'failed').length;
    const healTriggeredCount = healEvents.filter(e => e.status === 'triggered').length;

    await sendCaseSummaryNotification({
      title: result.status === 'passed'
        ? '✅ Playwright 自动化测试通过'
        : '❌ Playwright 自动化测试存在失败',
      status: result.status === 'passed' ? 'success' : 'error',
      total: this.total,
      passed: this.passed,
      failed: this.failed,
      skipped: this.skipped,
      healTriggeredCount,
      healSuccessCount,
      healFailedCount,
      failedCases: this.caseResults,
      healEvents,
      reportUrl: process.env.PLAYWRIGHT_REPORT_URL || process.env.BUILD_URL,
    });
  }
}

export default FeishuReporter;
```

这个 reporter 会在全部 case 执行完成后统一发飞书。

---

## 七、修改 playwright.config.ts

你现在是：

```ts
reporter: 'html',
```

改成：

```ts
reporter: [
  ['html'],
  ['./feishu-reporter.ts'],
],
```

完整示例：

```ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ['html'],
    ['./feishu-reporter.ts'],
  ],
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
```

---

## 八、feishu-bot.ts 增加汇总发送方法

在你的 `feishu-bot.ts` 里新增一个方法：

```ts
export async function sendCaseSummaryNotification(opts: {
  title: string;
  status: 'success' | 'error' | 'warning';
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  healTriggeredCount: number;
  healSuccessCount: number;
  healFailedCount: number;
  failedCases: Array<{
    title: string;
    file: string;
    status: string;
    error?: string;
  }>;
  healEvents: Array<{
    testName?: string;
    testFile?: string;
    action: string;
    status: string;
    description: string;
    originalLocator: string;
    healedLocator?: string;
    errorDetail?: string;
    pageUrl?: string;
  }>;
  reportUrl?: string;
}) {
  if (!APP_ID || !APP_SECRET || !CHAT_ID) {
    console.log(`[Feishu] Skipping summary notification: ${opts.title}`);
    return;
  }

  const statusEmoji = {
    success: '✅',
    error: '❌',
    warning: '⚠️',
  };

  const lines: FeishuLine[][] = [];

  lines.push([{ tag: 'text', text: `📊 测试总数：${opts.total}` }]);
  lines.push([{ tag: 'text', text: `✅ 通过：${opts.passed}` }]);
  lines.push([{ tag: 'text', text: `❌ 失败：${opts.failed}` }]);
  lines.push([{ tag: 'text', text: `⏭️ 跳过：${opts.skipped}` }]);
  lines.push([{ tag: 'text', text: `🔧 自愈触发：${opts.healTriggeredCount}` }]);
  lines.push([{ tag: 'text', text: `✅ 自愈成功：${opts.healSuccessCount}` }]);
  lines.push([{ tag: 'text', text: `❌ 自愈失败：${opts.healFailedCount}` }]);

  if (opts.reportUrl) {
    lines.push([{ tag: 'text', text: `📄 测试报告：${opts.reportUrl}` }]);
  }

  if (opts.failedCases.length > 0) {
    lines.push([{ tag: 'text', text: `\n失败用例明细：` }]);

    opts.failedCases.slice(0, 10).forEach((item, index) => {
      const error = item.error
        ? item.error.split('\n')[0].substring(0, 120)
        : '-';

      lines.push([
        {
          tag: 'text',
          text:
            `\n${index + 1}. ${item.title}\n` +
            `文件：${item.file}\n` +
            `状态：${item.status}\n` +
            `错误：${error}`,
        },
      ]);
    });
  }

  if (opts.healEvents.length > 0) {
    lines.push([{ tag: 'text', text: `\nAI 自愈明细：` }]);

    opts.healEvents.slice(0, 10).forEach((item, index) => {
      lines.push([
        {
          tag: 'text',
          text:
            `\n${index + 1}. ${item.testName || '-'}\n` +
            `元素：${item.description}\n` +
            `原始定位器：${item.originalLocator}\n` +
            `AI 定位器：${item.healedLocator || '-'}\n` +
            `自愈结果：${item.status}`,
        },
      ]);
    });
  }

  const token = await getTenantAccessToken();

  const payload = {
    receive_id: CHAT_ID,
    msg_type: 'post',
    content: JSON.stringify({
      zh_cn: {
        title: `${statusEmoji[opts.status]} ${opts.title}`,
        content: lines,
      },
    }),
  };

  try {
    await axios.post(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
      payload,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    console.log(`[Feishu] Summary notification sent: ${opts.title}`);
  } catch (error: any) {
    console.error(`[Feishu] Error sending summary notification: ${error.message}`);
  }
}
```

---

## 九、最终设计建议

我建议你不要只做“多条失败消息”，而是做成这个结构：

```text
飞书通知一：测试执行汇总
  - 总 case 数
  - 通过 case 数
  - 失败 case 数
  - 自愈触发次数
  - 自愈成功次数
  - 自愈失败次数

飞书通知二：失败详情
  - 失败 case 名称
  - 失败文件
  - 失败元素
  - 原始定位器
  - AI 修复定位器
  - 错误摘要
  - 页面 URL
  - Jenkins 报告链接
```

如果消息不多，可以合并成一条；如果 case 很多，建议一条汇总 + 一条详情，避免飞书消息太长。

---

## 十、你这个项目最适合的分层

最终代码结构建议变成：

```text
playwright-ai-healer
├── ai-healer.ts              # 自愈执行逻辑
├── healer-collector.ts       # 自愈事件收集
├── feishu-bot.ts             # 飞书消息发送
├── feishu-reporter.ts        # Playwright 执行结果汇总
├── playwright.config.ts      # 注册 reporter
├── tests/
│   └── xxx.spec.ts
└── test-results/
    └── ai-healer-events.jsonl
```

这个设计更适合你后面做成一篇文章：

> 从单点自愈到批量失败治理：Playwright + AI 的测试自愈通知体系设计

核心亮点就是：**不是只修一个元素，而是把整次自动化执行中的失败、自愈、审核全部结构化沉淀下来。**
