/**
 * OpenAI / DeepSeek Client — JSON-mode API wrapper for locator generation
 * Supports mock hook for testing without API calls
 */

import axios from 'axios';
import { HealInput, HealOutput } from '../skills/self-healing-locator/contract';

let mockHook: ((input: HealInput) => Promise<HealOutput>) | null = null;

/**
 * Set a mock function for testing (use in test setup)
 */
export function setMockOpenAIClient(
  mock: ((input: HealInput) => Promise<HealOutput>) | null
): void {
  mockHook = mock;
}

/**
 * Call OpenAI / DeepSeek API to generate a healed locator
 * Tries DEEPSEEK_API_KEY first, then falls back to OPENAI_API_KEY
 */
export async function callAIForHeal(input: HealInput): Promise<HealOutput> {
  // Check mock first (for testing)
  if (mockHook) {
    return mockHook(input);
  }

  const deepseekKey = process.env.DEEPSEEK_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!deepseekKey && !openaiKey) {
    throw new Error(
      'Neither DEEPSEEK_API_KEY nor OPENAI_API_KEY is configured. ' +
        'Set at least one in .env file.'
    );
  }

  // Use DeepSeek if available, otherwise OpenAI
  if (deepseekKey) {
    return callDeepSeekAPI(input, deepseekKey);
  } else {
    return callOpenAIAPI(input, openaiKey!);
  }
}

/**
 * Call DeepSeek API with JSON mode
 */
async function callDeepSeekAPI(input: HealInput, apiKey: string): Promise<HealOutput> {
  const prompt = buildLocatorPrompt(input);

  const response = await axios.post(
    'https://api.deepseek.com/chat/completions',
    {
      model: 'deepseek-chat',
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
      response_format: {
        type: 'json_object',
      },
      temperature: 0.3,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
    }
  );

  if (!response.data.choices?.[0]?.message?.content) {
    throw new Error('DeepSeek API returned empty content');
  }

  const content = response.data.choices[0].message.content;
  return parseAIResponse(content);
}

/**
 * Call OpenAI API with JSON mode
 */
async function callOpenAIAPI(input: HealInput, apiKey: string): Promise<HealOutput> {
  const prompt = buildLocatorPrompt(input);

  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4-turbo',
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
      response_format: {
        type: 'json_object',
      },
      temperature: 0.3,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
    }
  );

  if (!response.data.choices?.[0]?.message?.content) {
    throw new Error('OpenAI API returned empty content');
  }

  const content = response.data.choices[0].message.content;
  return parseAIResponse(content);
}

/**
 * Build the prompt for locator generation
 */
function buildLocatorPrompt(input: HealInput): string {
  return `You are an expert in Playwright test automation and CSS/XPath selectors.
A Playwright locator has stopped working. Your task is to generate a new, equivalent locator.

**Original Locator:** ${input.originalLocator}
**Element Description:** ${input.description}
**Page URL:** ${input.pageUrl}
**Action:** ${input.action}
${input.expectedText ? `**Expected Text:** ${input.expectedText}` : ''}
${input.errorMessage ? `**Error Message:** ${input.errorMessage}` : ''}
${input.domSnapshot ? `**Page DOM (visible interactive elements, one per line: tag#id.class text="..." placeholder="..." role="..."):**\n${input.domSnapshot}` : ''}

**Constraints:**
1. Return a Playwright locator string (CSS, XPath, ARIA, or text selector).
2. The locator must be unambiguous and match exactly ONE element (or throw error).
3. If you cannot generate a confident locator, set "confidence" to a value < 0.6.
4. Prefer simpler selectors over complex ones.
5. Avoid brittle selectors with dynamic IDs or frequently-changing classes.

**Response Format (JSON):**
{
  "locator": "button:has-text('确认')",
  "strategy": "css",
  "confidence": 0.85,
  "reason": "原始 class 已移除，通过文本内容精确匹配"
}

**Strategies:**
- "css": CSS selector (e.g., "button.confirm")
- "text": Playwright text selector (e.g., "text=Delete")
- "aria": ARIA label/role selector (e.g., "[role=button]:has-text('OK')")
- "xpath": XPath (use sparingly for complex DOM structures)

Now generate the healed locator in JSON format:`;
}

/**
 * Parse AI response and extract HealOutput
 */
function parseAIResponse(content: string): HealOutput {
  // Remove markdown code blocks if present
  let jsonStr = content.trim();
  if (jsonStr.startsWith('```json')) {
    jsonStr = jsonStr.slice(7);
  }
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.slice(3);
  }
  if (jsonStr.endsWith('```')) {
    jsonStr = jsonStr.slice(0, -3);
  }

  const parsed = JSON.parse(jsonStr.trim());

  if (!parsed.locator || !parsed.strategy || typeof parsed.confidence !== 'number') {
    throw new Error('AI response missing required fields: locator, strategy, confidence');
  }

  return {
    locator: parsed.locator,
    strategy: parsed.strategy as 'aria' | 'text' | 'css' | 'xpath',
    confidence: parsed.confidence,
    reason: parsed.reason || 'AI-generated healed locator',
  };
}
