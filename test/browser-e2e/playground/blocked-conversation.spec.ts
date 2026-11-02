import { test, expect } from '../fixtures/playground';

test('blocked conversations stay kernel-free through reselection and load history only after unblocking', async ({
  page,
}) => {
  const pane = page.locator('.pane-layer.pane-fg');
  const liam = page.getByRole('button', { name: /^Liam, chat/ });
  await liam.click();
  await expect(pane.locator('.msg-blocked-banner')).toBeVisible();
  await expect(pane.locator('.cb-tail-cap')).toHaveCount(0);
  const editorInstance = await pane.locator('app-chat-input').elementHandle();
  expect(editorInstance).not.toBeNull();
  await expect(pane.locator('app-chat-input')).toBeHidden();

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
  expect(
    await editorInstance!.evaluate(
      (node) => node === document.querySelector('.pane-fg app-chat-input'),
    ),
  ).toBe(true);

  // Repeated capability changes preserve both the editor instance and its draft.
  const back = page
    .locator('app-peer-profile')
    .getByRole('button', { name: 'Back', exact: true });
  await back.click();
  const input = pane.locator('app-chat-input [contenteditable="true"]');
  await input.fill('draft survives a blocked presentation');
  await pane.getByRole('button', { name: 'More options' }).click();
  await block.click();
  await expect(block).toBeChecked();
  await expect(pane.locator('app-chat-input')).toBeHidden();
  await expect(pane.locator('.cb-tail-cap')).toHaveCount(0);
  await block.click();
  await expect(block).not.toBeChecked();
  await back.click();
  await expect(input).toHaveText('draft survives a blocked presentation');
  expect(
    await editorInstance!.evaluate(
      (node) => node === document.querySelector('.pane-fg app-chat-input'),
    ),
  ).toBe(true);
});
