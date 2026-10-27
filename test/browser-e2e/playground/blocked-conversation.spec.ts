import { test, expect } from '../fixtures/playground';

test('blocked conversations stay kernel-free through reselection and load history only after unblocking', async ({
  page,
}) => {
  const pane = page.locator('.pane-layer.pane-fg');
  const liam = page.getByRole('button', { name: /^Liam, chat/ });
  await liam.click();
  await expect(pane.locator('.msg-blocked-banner')).toBeVisible();
  await expect(pane.locator('.cb-tail-cap')).toHaveCount(0);

  await liam.click();
  await expect(pane.locator('.msg-blocked-banner')).toBeVisible();
  await expect(pane.locator('.cb-tail-cap')).toHaveCount(0);

  await page.getByRole('button', { name: /^Alice, chat/ }).click();
  await expect(pane.locator('.msg-title-text')).toHaveText('Alice');
  await expect(pane.locator('.msg-row').first()).toBeVisible();
  await liam.click();
  await expect(pane.locator('.msg-title-text')).toHaveText('Liam');
  await expect(pane.locator('.msg-blocked-banner')).toBeVisible();
  await expect(pane.locator('.cb-tail-cap')).toHaveCount(0);

  await pane.getByRole('button', { name: 'More options' }).click();
  const block = page.locator('app-peer-profile').getByRole('switch').last();
  await expect(block).toBeChecked();
  await block.click();
  await expect(block).not.toBeChecked();
  await expect(pane.locator('.msg-blocked-banner')).toHaveCount(0);
  await expect(pane.locator('.msg-row').first()).toBeVisible();
});
