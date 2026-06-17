/**
 * State Capture — Extract 3-source DOM snapshot for AI context
 * Sources: ARIA attributes, visible interactive elements, error context
 */

import { Page } from '@playwright/test';

export interface DOMSnapshot {
  /** ARIA elements with labels/descriptions */
  ariaElements: Array<{
    tag: string;
    role?: string;
    label?: string;
    description?: string;
  }>;

  /** Visible interactive elements (buttons, inputs, links, etc.) */
  interactiveElements: Array<{
    tag: string;
    text?: string;
    classes?: string;
    id?: string;
    placeholder?: string;
    type?: string;
  }>;

  /** Current document structure (simplified tree) */
  documentTree: string;

  /** Any visible error messages or warnings */
  visibleErrors: string[];
}

/**
 * Capture current page DOM snapshot for AI healing
 * Extracts up to 100 elements max to avoid token bloat
 */
export async function capturePageState(page: Page): Promise<DOMSnapshot> {
  const snapshot = await page.evaluate(() => {
    const result: DOMSnapshot = {
      ariaElements: [],
      interactiveElements: [],
      documentTree: '',
      visibleErrors: [],
    };

    // 1. Capture ARIA elements
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

    // 2. Capture visible interactive elements
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

    // 3. Capture document tree (simplified)
    result.documentTree = captureSimplifiedTree(document.body);

    // 4. Capture visible errors/warnings
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
 * Check if an element is visible in the viewport
 */
function isElementVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) {
    return false;
  }

  // Check display and visibility CSS
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') {
    return false;
  }

  // Check if in viewport or has size
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * Capture simplified DOM tree (max depth 5, max children 10 per node)
 */
function captureSimplifiedTree(node: Node, depth = 0, maxDepth = 5): string {
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

    // Add up to 10 children
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
}

/**
 * Format snapshot for logging/debugging
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
