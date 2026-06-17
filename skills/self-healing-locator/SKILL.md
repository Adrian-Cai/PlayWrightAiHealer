# Self-Healing Locator Skill

## 任务目标

当 Playwright 元素定位器失效时，自动生成等效新定位器让测试不中断；并把每次自愈作为可审计事件通知团队。

## 输入契约

```ts
interface HealInput {
  originalLocator: string; // 失效的原始定位器
  description: string; // 元素的非位置性描述（如"确认按钮"）
  pageUrl: string; // 当前页面 URL
  action: "click" | "fill" | "assert" | "locate";
  expectedText?: string; // 对于 assert/click 动作，期望的文本
  errorMessage?: string; // Playwright 报的错误信息
  timeoutMs?: number; // 超时，默认 5000
}
```

## 输出契约

```ts
interface HealOutput {
  locator: string; // 新候选定位器
  strategy: "aria" | "text" | "css" | "xpath";
  confidence: number; // 0.0–1.0，< 0.6 则抛错
  reason: string; // 为什么选这个定位器
}

interface ValidationResult {
  valid: boolean;
  errors: string[]; // 若 valid=false，填此数组
}
```

## 适用边界 ✅

- class / role / parent 结构变化
- 文本措辞变更但语义不变
- 多层级父级 ID 变化但相对位置不变

## 不适用边界 ❌

- 跨域 iframe
- shadow DOM
- canvas / svg 内部元素
- 动态随机 ID（频繁变化）
- 用户拼写错误的 locator
- confidence < 0.6
- `description` 包含位置描述（"第三个按钮""右上角"）

## 关键原则

1. **不脑补**：AI 给出低 confidence → 抛错，不盲目使用
2. **多元素拒绝**：定位器匹配多个元素 → 抛错
3. **文本必一致**：元素文本与 expectedText 不符 → 抛错
4. **缓存优先**：同一 originalLocator + pageUrl → 检查缓存，300 秒过期
5. **每次可审计**：飞书通知 + .heal-events.jsonl 日志（不自动回写 spec）

## 事件流

```
aiClick / aiAssert / ... (Playwright wrapper)
  → cache lookup
  → if miss: capture 3-source state
  → OpenAI JSON-mode
  → Quality Gate validate()
  → event bus emit
    ├─ feishu-bot (通知)
    ├─ heal-cache-writer (缓存)
    └─ jsonl-logger (审计日志)
  → return healedLocator or throw
```

## 配置

环境变量（`.env`，已 gitignore）：

| 变量                | 必需 | 用途                                                                     |
| ------------------- | ---- | ------------------------------------------------------------------------ |
| `DEEPSEEK_API_KEY`  | 是   | DeepSeek API（`baseURL=https://api.deepseek.com`，模型 `deepseek-chat`） |
| `OPENAI_API_KEY`    | 否   | 回退 API key                                                             |
| `FEISHU_APP_ID`     | 否   | 飞书应用 ID                                                              |
| `FEISHU_APP_SECRET` | 否   | 飞书应用 Secret                                                          |
| `FEISHU_CHAT_ID`    | 否   | 接收通知的群 chat_id                                                     |

缺飞书配置时，通知被跳过但测试不失败。

---

## API 使用示例

### aiClick

```ts
import { aiClick } from "../utils/ai-click";

await aiClick(page, ".old-class-name", "确认按钮");
```

失效定位器 → 自动生成 → 飞书通知 → 新定位器生效。

### aiAssert

```ts
import { aiAssert } from "../utils/ai-assert";

await aiAssert(page, 'button:has-text("delete")', "删除确认框");
```

### aiLocate

```ts
import { aiLocate } from "../utils/ai-locate";

const newLocator = await aiLocate(page, ".removed-class", "用户昵称输入框");
console.log(newLocator); // 返回字符串，不自动 click/assert
```
