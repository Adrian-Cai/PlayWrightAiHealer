/**
 * Locator Repository — locator-store.json 的集中读写入口。
 *
 * 在当前 MVP 中，locator-store.json 不是临时调试文件，而是轻量级 Locator Registry：
 * - 测试用例通过 locatorKey 引用元素，不把具体 Locator 散落在 spec 里；
 * - AI 自愈生成的新 Locator 只能先进入 Proposal；
 * - 人工审核通过后，才允许通过 updateLocator() 修改这里的正式 Locator；
 * - 文件应提交到 Git，由 PR/代码审查保证可追踪、可回滚。
 *
 * 边界要求：
 * - 本模块只负责读写 locator-store.json，不关心 AI、飞书、PR 或测试执行；
 * - updateLocator() 只能更新已存在 key，不能静默创建新 key，避免审批回调引入未经设计的新元素资产。
 */

import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_STORE_PATH = path.resolve(process.cwd(), 'locator-store.json');

function getStorePath(): string {
  // 测试或本地隔离时可以通过 LOCATOR_STORE_PATH 指向临时文件，避免污染正式 locator-store.json。
  return process.env.LOCATOR_STORE_PATH || DEFAULT_STORE_PATH;
}

function readStore(): Record<string, string> {
  const file = getStorePath();
  if (!fs.existsSync(file)) {
    throw new Error(`locator-store.json not found: ${file}`);
  }

  const raw = fs.readFileSync(file, 'utf-8');
  const data = JSON.parse(raw);

  // Locator Store 必须是 { key: locator } 的扁平对象。
  // 数组、null 或嵌套结构都说明文件结构被破坏，应尽早失败。
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(`locator-store.json must be a JSON object: ${file}`);
  }

  return data as Record<string, string>;
}

function writeStore(data: Record<string, string>): void {
  const file = getStorePath();
  const dir = path.dirname(file);
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // 保持 2 空格格式和末尾换行，减少 PR diff 噪音。
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * 按 key 查询正式 Locator。
 *
 * 缺失 key 直接抛错，避免测试继续用 undefined/空字符串产生误导性错误。
 */
export function getLocator(locatorKey: string): string {
  const data = readStore();
  const locator = data[locatorKey];
  if (!locator || typeof locator !== 'string') {
    throw new Error(`Locator key not found in locator-store.json: ${locatorKey}`);
  }
  return locator;
}

/**
 * 更新已存在 key 的 Locator。
 *
 * 这是人工审核通过后的正式沉淀入口。它故意拒绝新增 key：
 * 新元素应该先由测试开发人员设计 key 和语义，再进入版本管理，而不是由 AI/回调服务临时创造。
 */
export function updateLocator(locatorKey: string, newLocator: string): void {
  if (!newLocator || typeof newLocator !== 'string') {
    throw new Error(`newLocator must be a non-empty string (key=${locatorKey})`);
  }

  const data = readStore();
  if (!(locatorKey in data)) {
    throw new Error(`Cannot update: locator key not found in locator-store.json: ${locatorKey}`);
  }

  data[locatorKey] = newLocator;
  writeStore(data);
}

/** 列出所有 Locator key，主要用于调试、校验脚本和后续管理工具。 */
export function listLocatorKeys(): string[] {
  return Object.keys(readStore());
}

/** 返回当前 Locator Store 的绝对路径，便于日志输出和测试断言。 */
export function getStoreFilePath(): string {
  return getStorePath();
}
