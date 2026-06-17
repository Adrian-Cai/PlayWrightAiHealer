import { test } from '@playwright/test';
import {
  aiClickByKey,
  aiAssertByKey,
} from '../utils/ai-healer';

test('AI Case UI Test - Manual Confirmation', async ({ page }, testInfo) => {
  // 1. Navigate to the project page
  await page.goto('https://ai-case.wiac.xyz/');

  // 2. Click "人工确认" (Manual Confirmation) using AI Healer wrapper
  //    Locator is resolved from locator-store.json by key.
  await aiClickByKey(page, 'manualConfirmMenu', "Antd 侧边菜单项，文本为'人工确认'", testInfo);

  // 3. Assert "批量确认" (Batch Confirmation) button exists using AI Healer
  await aiAssertByKey(page, 'batchConfirmButton', '批量确认按钮', testInfo);
});

test.fixme('AI Case UI Test - Project List Search', async ({ page }, testInfo) => {
  await page.goto('https://ai-case.wiac.xyz/');
  await aiClickByKey(page, 'projectSearchInput', '项目搜索输入框', testInfo);
});

test.fixme('AI Case UI Test - Create Project', async ({ page }, testInfo) => {
  await page.goto('https://ai-case.wiac.xyz/');
  await aiClickByKey(page, 'projectCreateButton', '新增项目按钮', testInfo);
});
