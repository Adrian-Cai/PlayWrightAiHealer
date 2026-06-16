import { Page, expect } from '@playwright/test';
import OpenAI from 'openai';
import * as dotenv from 'dotenv';
import { sendHealNotification } from './feishu-bot';

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: 'https://api.deepseek.com',
});

function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\[[\d;]*m/g, '');
}

/**
 * AI-powered self-healing click wrapper.
 * @param page The Playwright Page object.
 * @param locatorStr The original locator string (CSS or XPath).
 * @param description A human-readable description of what we are trying to click.
 */
export async function aiClick(page: Page, locatorStr: string, description: string) {
  try {
    // Attempt standard click with a short timeout
    await page.locator(locatorStr).click({ timeout: 5000 });
    console.log(`[AI Healer] Successfully clicked "${description}" using original locator.`);
  } catch (error) {
    console.warn(`[AI Healer] Original locator "${locatorStr}" failed for "${description}". Attempting self-healing...`);
    
    // 1. Capture state (Accessibility Tree or simplified DOM)
    // For simplicity, we'll use a simplified version of the DOM to stay within token limits.
    const domSnapshot = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('button, a, [role="button"], .ant-menu-item, span'));
      return elements.map(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;
        return {
          tag: el.tagName,
          text: el.textContent?.trim().substring(0, 50),
          className: el.className,
          id: el.id,
          role: el.getAttribute('role'),
        };
      }).filter(Boolean).slice(0, 100); // Limit to top 100 elements
    });

    // 2. Call OpenAI for a new locator
    const prompt = `
The Playwright locator "${locatorStr}" failed to find the element described as "${description}".
Here is a list of interactive/visible elements on the current page:
${JSON.stringify(domSnapshot, null, 2)}

Task: Suggest a new CSS or XPath locator that likely targets the element "${description}".
Rules:
1. Return ONLY the locator string (e.g. "button:has-text('Submit')").
2. Prefer robust locators.
3. No explanation, just the string.
`;

    try {
      const completion = await openai.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model: 'deepseek-chat',
      });

      const healedLocator = completion.choices[0].message.content?.trim();

      if (healedLocator) {
        console.info(`[AI Healer] AI suggested new locator: ${healedLocator}`);
        
        // Notify Feishu
        await sendHealNotification({
          title: '自愈触发（点击）',
          status: 'warning',
          description,
          originalLocator: locatorStr,
          healedLocator,
        });

        // 3. Retry with healed locator
        await page.locator(healedLocator).click({ timeout: 10000 });
        console.log(`[AI Healer] Successfully clicked "${description}" using healed locator.`);
      } else {
        throw new Error('AI could not suggest a locator.');
      }
    } catch (aiError) {
      console.error(`[AI Healer] Self-healing failed: ${aiError.message}`);
      await sendHealNotification({
        title: '自愈失败（点击）',
        status: 'error',
        description,
        originalLocator: locatorStr,
        errorDetail: stripAnsi(aiError.message),
      });
      throw error; // Re-throw the original Playwright error
    }
  }
}

/**
 * AI-powered self-healing assert wrapper.
 * @param page The Playwright Page object.
 * @param locatorStr The original locator string (CSS or XPath).
 * @param description A human-readable description of what we are asserting.
 */
export async function aiAssert(page: Page, locatorStr: string, description: string) {
  try {
    const loc = page.locator(locatorStr);
    await expect(loc).toBeVisible({ timeout: 5000 });
    console.log(`[AI Healer] Assertion passed for "${description}" using original locator.`);
  } catch (error) {
    console.warn(`[AI Healer] Assertion failed for "${description}" with locator "${locatorStr}". Attempting self-healing...`);

    // 1. Capture DOM state
    const domSnapshot = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('button, a, [role="button"], .ant-menu-item, span, th, td, label'));
      return elements.map(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;
        return {
          tag: el.tagName,
          text: el.textContent?.trim().substring(0, 50),
          className: el.className,
          id: el.id,
          role: el.getAttribute('role'),
        };
      }).filter(Boolean).slice(0, 100);
    });

    // 2. Call AI for a new locator
    const prompt = `
The Playwright locator "${locatorStr}" failed to assert the element described as "${description}".
Here is a list of interactive/visible elements on the current page:
${JSON.stringify(domSnapshot, null, 2)}

Task: Suggest a new CSS or XPath locator that likely targets the element "${description}".
Rules:
1. Return ONLY the locator string (e.g. "button:has-text('Submit')").
2. Prefer robust locators.
3. No explanation, just the string.
`;

    try {
      const completion = await openai.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model: 'deepseek-chat',
      });

      const healedLocator = completion.choices[0].message.content?.trim();

      if (healedLocator) {
        console.info(`[AI Healer] AI suggested new locator: ${healedLocator}`);

        // Notify Feishu
        await sendHealNotification({
          title: '自愈触发（断言）',
          status: 'warning',
          description,
          originalLocator: locatorStr,
          healedLocator,
        });

        // 3. Retry assertion with healed locator
        const healedLoc = page.locator(healedLocator);
        await expect(healedLoc).toBeVisible({ timeout: 10000 });
        console.log(`[AI Healer] Assertion passed for "${description}" using healed locator.`);
      } else {
        throw new Error('AI could not suggest a locator.');
      }
    } catch (aiError) {
      console.error(`[AI Healer] Self-healing failed: ${aiError.message}`);
      await sendHealNotification({
        title: '自愈失败（断言）',
        status: 'error',
        description,
        originalLocator: locatorStr,
        errorDetail: stripAnsi(aiError.message),
      });
      throw error; // Re-throw the original Playwright error
    }
  }
}
