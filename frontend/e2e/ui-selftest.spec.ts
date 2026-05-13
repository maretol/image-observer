import { expect, test } from '@playwright/test';

async function gotoScenario(page: import('@playwright/test').Page, scenario: string) {
  await page.goto(`/smoke.html?scenario=${scenario}`);
  await expect(page.getByTestId('smoke-root')).toBeVisible();
}

test('settings dialog visual baseline', async ({ page }) => {
  await gotoScenario(page, 'settings');
  await expect(page.getByTestId('smoke-root')).toHaveScreenshot('settings-dialog.png', {
    animations: 'disabled',
    caret: 'hide',
  });
});

test('classification view visual baseline', async ({ page }) => {
  await gotoScenario(page, 'classification');
  await expect(page.getByTestId('smoke-root')).toHaveScreenshot('classification-view.png', {
    animations: 'disabled',
    caret: 'hide',
  });
});

test('viewer grid visual baseline', async ({ page }) => {
  await gotoScenario(page, 'viewer');
  await expect(page.getByTestId('smoke-root')).toHaveScreenshot('viewer-grid.png', {
    animations: 'disabled',
    caret: 'hide',
  });
});
