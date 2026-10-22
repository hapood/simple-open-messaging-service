import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/playground';

const groupInfo = (page: Page) => page.locator('app-group-info').last();
const requests = (page: Page) => page.locator('app-friend-requests');
async function openGroup(page: Page) {
  await page.getByRole('button', { name: /^Playground Team, chat/ }).click();
  await page
    .locator('.pane-layer.pane-fg .msg-header')
    .getByRole('button')
    .click();
  await expect(groupInfo(page).locator('.member-overview-row')).toBeVisible();
}

test('friend requests: accept, reject, search, send and withdraw retain the new round state', async ({
  page,
}) => {
  await page
    .getByRole('button', { name: 'Friend requests', exact: true })
    .click();
  const dialog = requests(page);
  const maya = dialog
    .locator('app-friend-request-card')
    .filter({ hasText: 'Maya' });
  await maya.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(
    maya.getByRole('button', { name: 'Approved', exact: true }),
  ).toBeDisabled();
  const noah = dialog
    .locator('app-friend-request-card')
    .filter({ hasText: 'Noah' });
  await noah.getByRole('button', { name: 'Decline', exact: true }).click();
  await expect(
    noah.getByRole('button', { name: 'Rejected', exact: true }),
  ).toBeDisabled();
  await dialog.getByRole('tab').nth(0).click();
  await dialog.locator('input.search-input').fill('emma');
  await dialog.locator('form').getByRole('button').click();
  await dialog.locator('.result-action').click();
  await dialog
    .locator('app-friend-invite-dialog textarea')
    .fill('Playground request note');
  await dialog.locator('app-dialog-action-footer button').last().click();
  await dialog.getByRole('tab').nth(2).click();
  const emma = dialog
    .locator('app-friend-request-card')
    .filter({ hasText: 'Emma' });
  await expect(emma).toContainText('Playground request note');
  await emma.locator('.action button').click();
  await expect(emma.locator('.action button')).toBeDisabled();
  await dialog.locator('.page-header__back').click();
  await expect(page.getByRole('button', { name: /^Maya, chat/ })).toBeVisible();
  await page
    .getByRole('button', { name: 'Friend requests', exact: true })
    .click();
  await requests(page).getByRole('tab').nth(2).click();
  await expect(
    requests(page)
      .locator('app-friend-request-card')
      .filter({ hasText: 'Emma' })
      .locator('.action button'),
  ).toBeDisabled();
});

test('group requests: invite, revoke, accept and reject update candidates and roster', async ({
  page,
}) => {
  await openGroup(page);
  await groupInfo(page).locator('.invite-friends-row').click();
  const workspace = page.locator('app-group-join-requests');
  await expect(workspace.getByRole('tab').nth(1)).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const ivy = workspace.locator('.request-row').filter({ hasText: 'ivy' });
  await ivy.locator('.request-actions button').last().click();
  await expect(ivy.locator('.request-status')).toBeVisible();
  const jack = workspace.locator('.request-row').filter({ hasText: 'jack' });
  await jack.locator('.request-actions button').first().click();
  await expect(jack.locator('.request-status')).toBeVisible();
  await workspace.getByRole('tab').nth(2).click();
  const liam = workspace.locator('.candidate-row').filter({ hasText: 'Liam' });
  await liam.locator('button').click();
  await expect(liam.locator('button')).toBeDisabled();
  // Material paginates this narrow tab header; use its visible keyboard navigation.
  await workspace.getByRole('tab').nth(2).focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  const invitation = workspace
    .locator('.request-row')
    .filter({ hasText: 'Liam' });
  await invitation.locator('button').click();
  await expect(invitation.locator('.request-status')).toBeVisible();
  await workspace.getByRole('tab').nth(2).click();
  await expect(liam.locator('button')).toBeEnabled();
  await workspace.locator('.page-header__back').click();
  await expect(groupInfo(page).locator('.member-overview-row')).toContainText(
    '6 members',
  );
  await groupInfo(page).locator('.member-overview-row').click();
  await expect(
    groupInfo(page)
      .locator('.member-manager .member')
      .filter({ hasText: 'Ivy' }),
  ).toBeVisible();
  await expect(
    groupInfo(page)
      .locator('.member-manager .member')
      .filter({ hasText: 'Jack' }),
  ).toHaveCount(0);
});

test('group profile and announcement changes are projected back into the chat', async ({
  page,
}) => {
  await openGroup(page);
  await groupInfo(page).locator('.group-profile-row').click();
  await groupInfo(page)
    .locator('.profile-editor input:not([type=file])')
    .fill('Renamed Playground');
  await groupInfo(page)
    .locator('.profile-editor textarea')
    .fill('Updated mock group description');
  await groupInfo(page).locator('.save-profile-btn').click();
  await expect(groupInfo(page).locator('.group-profile-row')).toContainText(
    'Renamed Playground',
  );
  await groupInfo(page)
    .locator('.conversation-actions button.action-row')
    .first()
    .click();
  await groupInfo(page)
    .locator('.announcement-editor textarea')
    .fill('Mock announcement is live');
  await groupInfo(page)
    .locator('.announcement-editor-actions button')
    .last()
    .click();
  await expect(groupInfo(page).locator('.announcement-editor')).toHaveCount(0);
  await groupInfo(page)
    .locator('.conversation-actions button.action-row')
    .first()
    .click();
  await expect(
    groupInfo(page).locator('.announcement-editor textarea'),
  ).toHaveValue('Mock announcement is live');
});

test('new group creates an owner-only roster and dissolution retains read-only history', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'New group', exact: true }).click();
  const dialog = page.locator('app-new-group');
  await dialog.locator('.fields input').fill('New Playground Group');
  await dialog.locator('.fields textarea').fill('Created without a backend');
  await dialog.locator('.panel-actions button').last().click();
  await expect(dialog).toHaveCount(0);
  await page
    .getByRole('button', { name: /^New Playground Group, chat/ })
    .click();
  await page
    .locator('.pane-layer.pane-fg .msg-header')
    .getByRole('button')
    .click();
  await expect(groupInfo(page).locator('.member-overview-row')).toContainText(
    '1 member',
  );
  await groupInfo(page).locator('.group-actions button').last().click();
  await page.locator('app-confirm-dialog').getByRole('button').last().click();
  await expect(page.locator('app-confirm-dialog')).toHaveCount(0);
  await expect(page.locator('.pane-layer.pane-fg .msg-header')).toContainText(
    'New Playground Group',
  );
  await page
    .locator('.pane-layer.pane-fg .msg-header')
    .getByRole('button')
    .click();
  await expect(groupInfo(page).locator('.group-actions')).toHaveCount(0);
  await expect(
    page.locator('.pane-layer.pane-fg .msg-blocked-banner'),
  ).toContainText('dissolved');
});

test('member management updates roles, removal, transfer and leave', async ({
  page,
}) => {
  await openGroup(page);
  await groupInfo(page).locator('.member-overview-row').click();
  const roster = groupInfo(page).locator('.member-manager');
  const maya = roster.locator('.member').filter({ hasText: 'Maya' });
  await maya.locator('.more-btn').click();
  await page.getByRole('menuitem').first().click();
  await page.locator('app-confirm-dialog').getByRole('button').last().click();
  await expect(maya.locator('.role-badge')).toHaveText('Admin');
  const noah = roster.locator('.member').filter({ hasText: 'Noah' });
  await noah.locator('.more-btn').click();
  await page.getByRole('menuitem').nth(1).click();
  await page.locator('app-confirm-dialog').getByRole('button').last().click();
  await expect(noah).toHaveCount(0);
  await maya.locator('.more-btn').click();
  await page.getByRole('menuitem').last().click();
  await page.locator('app-confirm-dialog').getByRole('button').last().click();
  await expect(maya.locator('.role-badge')).toHaveText('Owner');
  await expect(
    roster.locator('.member').filter({ hasText: 'Me' }).locator('.role-badge'),
  ).toHaveText('Admin');
  await roster.locator('.page-header__back').click();
  await page
    .locator('.pane-layer.pane-fg .msg-header')
    .getByRole('button')
    .click();
  await expect(groupInfo(page).locator('.group-actions button')).toHaveCount(1);
  await groupInfo(page).locator('.group-actions button').click();
  await page.locator('app-confirm-dialog').getByRole('button').last().click();
  await expect(
    page.locator('.pane-layer.pane-fg .msg-blocked-banner'),
  ).toBeVisible();
});

test('accepting a group invitation adds a group, and unfriend keeps a read-only conversation', async ({
  page,
}) => {
  await page
    .getByRole('button', { name: 'Friend requests', exact: true })
    .click();
  const bookClub = requests(page)
    .locator('app-friend-request-card')
    .filter({ hasText: 'Book Club' });
  await bookClub
    .getByRole('button', { name: 'Join group', exact: true })
    .click();
  await expect(
    bookClub.getByRole('button', { name: 'Join group', exact: true }),
  ).toHaveCount(0);
  await expect(bookClub.locator('.action button')).toHaveCount(1);
  await expect(bookClub.locator('.action button')).toBeDisabled();
  await requests(page).locator('.page-header__back').click();
  await expect(
    page.getByRole('button', { name: /^Book Club, chat/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: /^Alice, chat/ }).click();
  await page
    .locator('.pane-layer.pane-fg .msg-header')
    .getByRole('button')
    .last()
    .click();
  await page.locator('app-peer-profile .relationship-actions button').click();
  await page.locator('app-confirm-dialog').getByRole('button').last().click();
  await expect(
    page.getByRole('button', { name: /^Alice, chat/ }),
  ).toBeVisible();
  await expect(page.locator('.pane-layer.pane-fg app-chat-input')).toHaveCount(
    0,
  );
  await expect(page.locator('.pane-layer.pane-fg .msg-header')).toContainText(
    'Alice',
  );
  await expect
    .poll(() =>
      page
        .locator('.pane-layer.pane-fg .cb-tail-cap')
        .evaluate((tail) => (tail as HTMLElement).offsetHeight),
    )
    .toBe(16);
});
