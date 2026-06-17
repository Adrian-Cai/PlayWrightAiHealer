/**
 * Self-Healing Locator Skill — Input/Output Contracts & Event Types
 * Shared types for HealInput, HealOutput, ValidationResult, and HealEvent
 */

// ============================================================================
// Input Contracts
// ============================================================================

export interface HealInput {
  /** 失效的原始定位器 */
  originalLocator: string;

  /**
   * 定位器在 locator-store.json 中的 key（可选）。
   * 当通过 aiXxxByKey 调用时填写，便于事件/提案追溯到集中管理的 locator。
   */
  locatorKey?: string;

  /** 元素的非位置性描述（例："确认按钮"、"用户昵称输入框"） */
  description: string;

  /** 当前页面 URL */
  pageUrl: string;

  /** 待执行的动作 */
  action: 'click' | 'fill' | 'assert' | 'locate';

  /** 对于 assert/click，期望的文本内容 */
  expectedText?: string;

  /** Playwright 抛出的原始错误信息 */
  errorMessage?: string;

  /** DOM 快照（格式化后的可见交互元素列表，供 AI 生成精确 locator） */
  domSnapshot?: string;

  /** 超时时间（毫秒），默认 5000 */
  timeoutMs?: number;

  /** 填充值（仅用于 fill 动作） */
  fillValue?: string;
}

// ============================================================================
// Output Contracts
// ============================================================================

export interface HealOutput {
  /** 新候选定位器 */
  locator: string;

  /** 定位策略 */
  strategy: 'aria' | 'text' | 'css' | 'xpath';

  /** 置信度 0.0–1.0，< 0.6 被视为不可靠 */
  confidence: number;

  /** 为什么选择这个定位器 */
  reason: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings?: string[];
}

// ============================================================================
// Event Types (for Event Bus)
// ============================================================================

export type HealEventType =
  | 'HEAL_START'
  | 'CACHE_HIT'
  | 'STATE_CAPTURED'
  | 'AI_CALLED'
  | 'VALIDATION_PASSED'
  | 'VALIDATION_FAILED'
  | 'RETRY_SUCCESS'
  | 'HEAL_FAILED'
  | 'HEAL_SUCCESS';

export type HealStatus = 'success' | 'warning' | 'error' | 'info';

export interface HealEvent {
  /** 事件 ID（UUID） */
  id: string;

  /** 事件类型 */
  type: HealEventType;

  /** 事件时间戳（ISO 8601） */
  timestamp: string;

  /** 原始输入 */
  input: HealInput;

  /** AI 输出（若有） */
  output?: HealOutput;

  /** 验证结果（若有） */
  validation?: ValidationResult;

  /** 错误信息（若有） */
  error?: string;

  /** 重试次数 */
  retryCount: number;

  /** 运行时间（毫秒） */
  durationMs: number;

  /** 缓存是否命中 */
  cacheHit: boolean;

  /** 最终定位器（若成功） */
  finalLocator?: string;

  /** Jenkins BUILD_URL（若存在） */
  jenkinsUrl?: string;

  /** 测试名称（若存在） */
  testName?: string;
}

// ============================================================================
// Cache Entry
// ============================================================================

export interface CacheEntry {
  /** 输出 */
  output: HealOutput;

  /** 创建时间戳 */
  createdAt: number;

  /** 过期时间（毫秒后），默认 300 秒 */
  expiresAt: number;

  /** 最后使用时间 */
  lastUsedAt: number;

  /** 使用次数 */
  usageCount: number;
}

// ============================================================================
// Cache Storage (LRU format)
// ============================================================================

export interface CacheStorage {
  [cacheKey: string]: CacheEntry;
}

// ============================================================================
// Quality Gate Discriminated Union
// ============================================================================

export type QualityGateResult =
  | {
      status: 'pass';
      output: HealOutput;
    }
  | {
      status: 'fail';
      errors: string[];
    };
