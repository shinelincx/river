import { expect, request as apiRequest, test, type APIRequestContext, type Page } from '@playwright/test';

async function createGuest(api: APIRequestContext, nickname: string) {
  const response = await api.post('/api/guests', { data: { nickname } });
  expect(response.ok()).toBe(true);
  return (await response.json()).player as { id: string };
}

async function enterTable(page: Page, roomName: string) {
  await page.getByRole('button', { name: new RegExp(roomName) }).click();
  await page.getByRole('button', { name: /进入牌桌/ }).click();
}

test('production API restores the same active hand from PostgreSQL after a process restart', async ({ browser, page, request }) => {
  const roomName = `生产恢复-${Date.now()}`;
  await createGuest(request, '生产房主');
  const roomResponse = await request.post('/api/rooms', {
    data: { name: roomName, maxSeats: 6, smallBlind: 20, initialChips: 1_500 }
  });
  expect(roomResponse.ok()).toBe(true);
  const room = (await roomResponse.json()).room as { id: string; inviteCode: string };

  const guestApi = await apiRequest.newContext({ baseURL: 'http://localhost:5173' });
  const guest = await createGuest(guestApi, '生产来宾');
  expect((await guestApi.post(`/api/invites/${room.inviteCode}/join`)).ok()).toBe(true);
  expect((await request.post(`/api/rooms/${room.id}/credits`, {
    headers: { 'idempotency-key': `production-credit-${room.id}` },
    data: { playerId: guest.id, amount: 800 }
  })).ok()).toBe(true);

  await page.context().addCookies((await request.storageState()).cookies);
  const guestContext = await browser.newContext({ storageState: await guestApi.storageState() });
  const guestPage = await guestContext.newPage();
  await Promise.all([page.goto('/'), guestPage.goto('/')]);
  await Promise.all([enterTable(page, roomName), enterTable(guestPage, roomName)]);
  await page.getByRole('button', { name: /开始第一手/ }).click();
  await expect(page.locator('.holeCards .playingCard')).toHaveCount(2);
  await expect(guestPage.locator('.holeCards .playingCard')).toHaveCount(2);
  const hostCards = await page.locator('.holeCards .playingCard').allTextContents();
  const guestCards = await guestPage.locator('.holeCards .playingCard').allTextContents();

  const restart = await request.post('http://127.0.0.1:3101/restart');
  expect(restart.ok()).toBe(true);
  await Promise.all([page.reload(), guestPage.reload()]);
  await Promise.all([enterTable(page, roomName), enterTable(guestPage, roomName)]);

  await expect(page.locator('.holeCards .playingCard')).toHaveText(hostCards);
  await expect(guestPage.locator('.holeCards .playingCard')).toHaveText(guestCards);
  const hostFold = page.locator('.foldButton');
  if (await hostFold.isEnabled()) await hostFold.click();
  else await guestPage.locator('.foldButton').click();
  await expect(page.getByRole('button', { name: '手牌记录' })).toBeVisible();

  await guestContext.close();
  await guestApi.dispose();
});
