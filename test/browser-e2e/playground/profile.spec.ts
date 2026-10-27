import { test, expect } from '../fixtures/playground';

for (const width of [1440, 390]) {
  test(`self profile edits update the mock presentation at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page
      .getByRole('button', { name: 'Edit profile', exact: true })
      .click();
    const editor = page.locator('app-profile-editor');
    await expect(editor).toBeVisible();
    await expect(editor.locator('.account-address-row')).toContainText(
      'me@chat.example.test',
    );
    const name = editor.locator('input[autocomplete=nickname]');
    await name.fill('');
    await expect(editor.locator('.save-btn')).toBeDisabled();
    await name.fill('Playground Explorer');
    await editor.locator('textarea').fill('A profile held only in memory.');
    const avatarBase64 = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#3377aa';
      context.fillRect(0, 0, 64, 64);
      return canvas.toDataURL('image/webp').split(',')[1];
    });
    await editor.locator('input[type=file]').setInputFiles({
      name: 'avatar.webp',
      mimeType: 'image/webp',
      buffer: Buffer.from(avatarBase64, 'base64'),
    });
    await expect(editor.locator('app-avatar-editor canvas')).toBeVisible();
    await editor
      .locator(
        'app-avatar-editor .page-header__action button, app-avatar-editor button[pageHeaderAction]',
      )
      .click();
    await expect(editor.locator('.avatar img')).toBeVisible();
    await editor.locator('.save-btn').click();
    await expect(editor).not.toBeVisible();
    const profileButton = page.getByRole('button', {
      name: 'Edit profile',
      exact: true,
    });
    await expect(profileButton.locator('img')).toBeVisible();
    await page.getByRole('button', { name: /^Playground Team, chat/ }).click();
    await page
      .locator('.pane-layer.pane-fg .msg-header')
      .getByRole('button', { name: 'More options', exact: true })
      .click();
    const group = page.locator('app-group-info').last();
    await group.locator('.member-overview-row').click();
    await expect(
      group.locator('.member').filter({ hasText: 'Playground Explorer' }),
    ).toBeVisible();
  });
}
