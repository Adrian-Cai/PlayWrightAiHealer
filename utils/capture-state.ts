/**
 * State Capture — 给 AI 自愈提供页面上下文。
 *
 * 设计目标：让模型看到“足够生成 Locator 的信息”，而不是把整页 DOM 原样塞进去。
 * 因此这里只抓四类信息：
 * 1. ARIA 元素：role/aria-label 等语义化信息，适合生成稳定 Locator；
 * 2. 可见交互元素：button/input/link/menu item 等真实可操作目标；
 * 3. 简化 DOM 树：用于辅助理解页面结构，但限制深度和子节点数量；
 * 4. 可见错误信息：帮助模型理解当前页面是否处于异常状态。
 *
 * 注意：本文件只负责采集页面状态，不负责调用 AI，也不负责判断候选 Locator 是否可用。
 */

import { Page } from '@playwright/test';

export interface DOMSnapshot {
  /** 页面上的语义化节点。优先用于生成 role/aria 相关 Locator。 */
  ariaElements: Array<{
    tag: string;
    role?: string;
    label?: string;
    description?: string;
  }>;

  /** 当前页面可见且可能被操作的元素，例如按钮、链接、输入框、Antd 菜单项。 */
  interactiveElements: Array<{
    tag: string;
    text?: string;
    classes?: string;
    id?: string;
    placeholder?: string;
    type?: string;
  }>;

  /** 被截断后的 DOM 结构，用于辅助理解上下级关系。 */
  documentTree: string;

  /** 页面上可见的错误、警告、通知信息。 */
  visibleErrors: string[];
}

/**
 * 抓取当前页面快照。
 *
 * 采集数量被刻意限制：ARIA 最多 50 个，可交互元素最多 50 个，DOM 树最多 5 层，
 * 目的是控制 token 成本，并降低无关节点对模型判断的干扰。
 */
export async function capturePageState(page: Page): Promise<DOMSnapshot> {
  const snapshot = await page.evaluate(() => {
    const isElementVisible = (el: Element): boolean => {
      if (!(el instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') {
        return false;
      }

      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const captureSimplifiedTree = (node: Node, depth = 0, maxDepth = 5): string => {
      if (depth > maxDepth) {
        return '';
      }

      const indent = '  '.repeat(depth);
      let result = '';

      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent?.trim();
        if (text && text.length < 100) {
          result += `${indent}[text: ${text}]\n`;
        }
        return result;
      }

      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element;
        const tag = el.tagName.toLowerCase();
        const id = el.id ? ` id="${el.id}"` : '';
        const classes = el.className ? ` class="${el.className}"` : '';
        result += `${indent}<${tag}${id}${classes}>\n`;

        let childCount = 0;
        for (const child of node.childNodes) {
          if (childCount >= 10) {
            result += `${indent}  ...\n`;
            break;
          }
          result += captureSimplifiedTree(child, depth + 1, maxDepth);
          childCount++;
        }
      }

      return result;
    };

    const result: DOMSnapshot = {
      ariaElements: [],
      interactiveElements: [],
      documentTree: '',
      visibleErrors: [],
    };

    // 1. 语义化元素：role/aria-label 往往比 class、层级 CSS 更稳定。
    const ariaElements = document.querySelectorAll('[role], [aria-label], [aria-describedby]');
    Array.from(ariaElements).slice(0, 50).forEach((el) => {
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role');
      const label = el.getAttribute('aria-label');
      const description = el.getAttribute('aria-description');

      result.ariaElements.push({
        tag,
        role: role || undefined,
        label: label || undefined,
        description: description || undefined,
      });
    });

    // 2. 可交互元素：AI 主要从这里选择候选 Locator。
    // Antd 项目中常见 .ant-menu-item / .ant-btn，因此在原生选择器之外额外收集。
    const selectors = [
      'button',
      'a[href]',
      'input[type="text"]',
      'input[type="email"]',
      'input[type="password"]',
      'input[type="checkbox"]',
      'input[type="radio"]',
      'select',
      'textarea',
      '[role="button"]',
      '[role="menuitem"]',
      '[role="link"]',
      '.ant-menu-item',
      '.ant-btn',
    ];

    const interactiveElements: Set<Element> = new Set();
    selectors.forEach((sel) => {
      const els = document.querySelectorAll(sel);
      Array.from(els).forEach((el) => {
        if (isElementVisible(el)) {
          interactiveElements.add(el);
        }
      });
    });

    Array.from(interactiveElements).slice(0, 50).forEach((el) => {
      const tag = el.tagName.toLowerCase();
      const text = el.textContent?.trim().slice(0, 100);
      const classes = el.className || '';
      const id = el.id || '';
      const placeholder = el.getAttribute('placeholder');
      const type = el.getAttribute('type');

      result.interactiveElements.push({
        tag,
        text: text || undefined,
        classes: classes || undefined,
        id: id || undefined,
        placeholder: placeholder || undefined,
        type: type || undefined,
      });
    });

    // 3. 简化 DOM 树：提供结构感，但避免全量 DOM 造成 token 膨胀。
    result.documentTree = captureSimplifiedTree(document.body);

    // 4. 可见错误/警告：如果页面处于异常状态，错误文案可以帮助判断原 Locator 失败原因。
    const errorSelectors = [
      '.ant-alert',
      '.error',
      '.warning',
      '[role="alert"]',
      '.ant-message',
      '.ant-notification',
    ];

    errorSelectors.forEach((sel) => {
      const els = document.querySelectorAll(sel);
      Array.from(els).forEach((el) => {
        if (isElementVisible(el)) {
          const text = el.textContent?.trim();
          if (text) {
            result.visibleErrors.push(text.slice(0, 200));
          }
        }
      });
    });

    return result;
  });

  return snapshot;
}

/**
 * 将 DOMSnapshot 格式化为便于日志查看的短文本。
 *
 * 这是调试/报告辅助函数，不参与 AI prompt 的主格式化；healer-core 会额外压缩 interactiveElements。
 */
export function formatSnapshot(snapshot: DOMSnapshot): string {
  const lines: string[] = [];

  lines.push('=== ARIA Elements ===');
  snapshot.ariaElements.slice(0, 10).forEach((el) => {
    lines.push(`  <${el.tag} role="${el.role}" label="${el.label}">`);
  });

  lines.push('\n=== Interactive Elements ===');
  snapshot.interactiveElements.slice(0, 10).forEach((el) => {
    const info = [el.tag];
    if (el.text) info.push(`"${el.text}"`);
    if (el.classes) info.push(`.${el.classes}`);
    if (el.id) info.push(`#${el.id}`);
    lines.push(`  ${info.join(' ')}`);
  });

  if (snapshot.visibleErrors.length > 0) {
    lines.push('\n=== Visible Errors ===');
    snapshot.visibleErrors.slice(0, 5).forEach((err) => {
      lines.push(`  ${err}`);
    });
  }

  return lines.join('\n');
}
