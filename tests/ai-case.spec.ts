import { test, expect } from '@playwright/test';
import { aiClick, aiAssert } from '../utils/ai-healer';

test('AI Case UI Test - Manual Confirmation', async ({ page }, testInfo) => {
  // 1. Navigate to the project page
  await page.goto('https://ai-case.wiac.xyz/');

  // 2. Click "人工确认" (Manual Confirmation) using AI Healer wrapper
  await aiClick(
    page,
    '.ant-menu-item:has-text("人工确认")',
    '人工确认菜单项',
    testInfo
  );

  // 3. Assert "批量确认" (Batch Confirmation) button exists using AI Healer
  await aiAssert(page, 'text=批量确认', '批量确认按钮', testInfo);
});

test.fixme('AI Case UI Test - Project List Search', async ({ page }, testInfo) => {
  await page.goto('https://ai-case.wiac.xyz/');
  await aiClick(
    page,
    'input[placeholder="请输入项目名称"]',
    '项目搜索输入框',
    testInfo
  );
});

test.fixme('AI Case UI Test - Create Project', async ({ page }, testInfo) => {
  await page.goto('https://ai-case.wiac.xyz/');
  await aiClick(page, 'text=新增项目', '新增项目按钮', testInfo);
});
