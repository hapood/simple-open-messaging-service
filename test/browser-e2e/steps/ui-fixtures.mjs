import { expect } from '@playwright/test';

/**
 * Create a local account through the visible Admin user-management form.
 * This helper intentionally avoids direct API and database setup.
 */
export async function createLocalUser(page, { account, displayName }) {
  if (!/^[a-z][a-z0-9.]{2,30}$/.test(account)) {
    throw new Error(`Invalid local test account: ${account}`);
  }
  if (typeof displayName !== 'string' || displayName.length === 0) {
    throw new Error('A display name is required');
  }

  if (!page.url().includes('/admin/users')) {
    await page.goto(new URL('/admin/users', page.url()).href, {
      waitUntil: 'domcontentloaded',
    });
  }

  const main = page.locator('main');
  const search = main.locator('input[type="search"]');
  const overlay = page.locator('[data-slot="dialog-overlay"]');
  const matchingRow = () =>
    main.locator('tbody tr').filter({
      has: page.locator('td').filter({ hasText: new RegExp(`^${account}$`) }),
    });
  await expect(search).toBeVisible();

  await search.fill(account);
  if ((await matchingRow().count()) === 1) {
    return { account, displayName, created: false };
  }

  let dialog = page.locator('[role="dialog"]:visible');
  if ((await dialog.count()) === 0) {
    await expect(overlay).toBeHidden();
    await search.locator('xpath=following::button[1]').click();
    dialog = page.locator('[role="dialog"]:visible');
  }
  await expect(dialog).toHaveCount(1);
  await dialog.locator('#cu-account').fill(account);
  await dialog.locator('#cu-name').fill(displayName);
  await dialog.locator('form button[type="submit"]').click();
  await expect(dialog).toBeHidden();
  await expect(overlay).toBeHidden();

  await search.fill(account);
  await expect(matchingRow()).toHaveCount(1);
  return { account, displayName, created: true };
}

/** Send a local friend request using the signed-in user's visible Web controls. */
export async function requestLocalFriend(page, { account, displayName }) {
  if (!/^[a-z][a-z0-9.]{2,30}$/.test(account)) {
    throw new Error(`Invalid local test account: ${account}`);
  }
  const rail = page.locator('app-icon-rail');
  await expect(rail).toBeVisible();
  await rail.locator('.rail-btn').nth(1).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('[role="tab"]').first().click();
  const search = dialog.locator('form[role="search"]');
  await search.locator('input').fill(account);
  await search.locator('button[type="submit"]').click();

  const result = dialog.locator('.result-row').filter({ hasText: displayName });
  await expect(result).toHaveCount(1);
  await result.locator('button.result-action').click();
  const invite = dialog.locator('app-friend-invite-dialog');
  await expect(invite).toBeVisible();
  await invite.locator('app-dialog-action-footer button').last().click();
  await expect(invite).toBeHidden();
  await expect(result.locator('.result-status')).toBeVisible();
  return { account, displayName };
}

/** Accept a pending local friend request using the recipient's visible Web controls. */
export async function acceptLocalFriend(page, { displayName }) {
  const rail = page.locator('app-icon-rail');
  await expect(rail).toBeVisible();
  await rail.locator('.rail-btn').nth(1).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('[role="tab"]').nth(1).click();
  const request = dialog
    .locator('app-friend-request-card')
    .filter({ hasText: displayName });
  await expect(request).toHaveCount(1);
  await request.locator('button').last().click();
  await expect(request.locator('button[disabled]')).toHaveCount(1);
  await expect(page.locator('app-thread-list')).toContainText(displayName);
  return { displayName };
}
