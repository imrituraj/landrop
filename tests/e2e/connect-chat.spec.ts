import { expect, test } from '@playwright/test';
import { openDevice, pair, selectPeer } from './fixtures.ts';

test('two browsers pair via invitation link, connect directly, and chat', async ({ browser }) => {
  const a = await openDevice(browser, 'Alice');
  const b = await openDevice(browser, 'Bob');
  await pair(a, b);

  await selectPeer(a, 'Bob');
  await selectPeer(b, 'Alice');
  const input = a.page.getByRole('textbox', { name: 'Message' });
  await input.fill('hello from alice https://example.com/x');
  await input.press('Enter');

  const received = b.page.getByTestId('chat-message').filter({ hasText: 'hello from alice' });
  await expect(received).toHaveAttribute('data-direction', 'in');
  await expect(received.getByRole('link', { name: 'https://example.com/x' })).toHaveAttribute('href', 'https://example.com/x');
  await expect(a.page.getByTestId('chat-status').last()).toHaveText('Delivered');

  // Multiline with Shift+Enter, and a reply.
  const bInput = b.page.getByRole('textbox', { name: 'Message' });
  await bInput.fill('line one');
  await bInput.press('Shift+Enter');
  await bInput.type('line two');
  await bInput.press('Enter');
  await expect(a.page.getByTestId('chat-message').filter({ hasText: 'line one' })).toContainText('line two');
  await expect(b.page.getByTestId('chat-status').last()).toHaveText('Delivered');

  // HTML is rendered as text, never as markup.
  await input.fill('<img src=x onerror=alert(1)><b>bold</b>');
  await input.press('Enter');
  await expect(b.page.getByTestId('chat-text').last()).toHaveText('<img src=x onerror=alert(1)><b>bold</b>');
  expect(await b.page.locator('[data-testid=chat-text] b').count()).toBe(0);

  await a.context.close();
  await b.context.close();
});

test('short-code join requires approval by a member', async ({ browser }) => {
  const a = await openDevice(browser, 'Alice');
  const b = await openDevice(browser, 'Bob');
  await a.page.getByRole('button', { name: 'Create room' }).click();
  const codeText = await a.page.getByLabel(/^Room code /).textContent();

  await b.page.getByLabel('Paste an invitation link or type a room code').fill(codeText!.toLowerCase());
  await b.page.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(b.page.getByText('Waiting for approval')).toBeVisible();

  const dialog = a.page.getByRole('dialog', { name: 'A device wants to join' });
  await expect(dialog).toContainText('Bob');
  await dialog.getByRole('button', { name: 'Approve' }).click();
  await expect(b.page.getByRole('button', { name: /^Alice, / })).toContainText('Direct', { timeout: 30_000 });

  await a.context.close();
  await b.context.close();
});

test('denied code join and invalid invitations show clear errors', async ({ browser }) => {
  const a = await openDevice(browser, 'Alice');
  const b = await openDevice(browser, 'Bob');
  await b.page.getByLabel('Paste an invitation link or type a room code').fill('ZZZZ-ZZZZ');
  await b.page.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(b.page.getByText('That room code is invalid or has expired.')).toBeVisible();

  await a.page.getByRole('button', { name: 'Create room' }).click();
  const codeText = await a.page.getByLabel(/^Room code /).textContent();
  await b.page.getByLabel('Paste an invitation link or type a room code').fill(codeText!);
  await b.page.getByRole('button', { name: 'Join', exact: true }).click();
  await a.page.getByRole('dialog', { name: 'A device wants to join' }).getByRole('button', { name: 'Deny' }).click();
  await expect(b.page.getByText('Your request to join was declined.')).toBeVisible();

  await b.page.goto(`/#join=${'a'.repeat(32)}.${'b'.repeat(43)}`);
  await expect(b.page.getByText('Room not found, or the invitation is invalid.')).toBeVisible();

  await a.context.close();
  await b.context.close();
});
