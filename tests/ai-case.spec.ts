import { test, expect } from '@playwright/test';
import { aiClick } from '../utils/ai-healer';

test('AI Case UI Test - Manual Confirmation', async ({ page }) => {
  // 1. Navigate to the project page
  await page.goto('https://ai-case.wiac.xyz/');

  // 2. Click "人工确认" (Manual Confirmation) using AI Healer wrapper
  await aiClick(page, '.ant-menu-item:has-text("人工确认")', '人工确认菜单项');

  // 3. Assert "批量确认" (Batch Confirmation) button exists
  const batchConfirmBtn = page.getByText('批量确认');
  await expect(batchConfirmBtn).toBeVisible();
});
