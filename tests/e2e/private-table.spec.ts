import { expect, request as apiRequest, test, type APIRequestContext } from '@playwright/test';

const baseURL = 'http://localhost:5173';

async function createGuest(api: APIRequestContext, nickname: string) {
  const response = await api.post('/api/guests', { data: { nickname } });
  expect(response.ok()).toBe(true);
  return (await response.json()).player as { id: string; nickname: string };
}

async function createRoom(api: APIRequestContext, name: string, maxSeats: 6 | 9 = 6) {
  const response = await api.post('/api/rooms', {
    data: { name, maxSeats, smallBlind: 20, initialChips: 1_500 }
  });
  expect(response.ok()).toBe(true);
  return (await response.json()).room as { id: string; inviteCode: string };
}

test.describe('私人牌局浏览器验收', () => {
  test('新设备在有效邀请深链中创建游客身份并加入私人房', async ({ page, request }) => {
    await createGuest(request, '深链房主');
    const room = await createRoom(request, '深链牌局');

    await page.goto(`/join/${room.inviteCode}`);
    await page.getByLabel('你的牌桌昵称').fill('深链来宾');
    await page.getByRole('button', { name: '开始我的私人牌局' }).click();

    const inviteInput = page.getByLabel('邀请码');
    await expect(inviteInput).toHaveValue(room.inviteCode);
    await page.getByRole('button', { name: '加入牌局' }).click();

    await expect(page.getByText('INVITED PLAYER', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '深链牌局' })).toBeVisible();
    await expect(page).toHaveURL(`${baseURL}/`);
    const self = page.locator('.memberRow').filter({ hasText: '深链来宾（你）' });
    await expect(self).toContainText('0');
  });

  test('房主与受邀玩家在独立 Cookie 上下文中只看到各自允许的积分与手牌信息', async ({ browser, page, request }) => {
    const host = await createGuest(request, '隐私房主');
    const room = await createRoom(request, '隐私牌局');
    const guestApi = await apiRequest.newContext({ baseURL });
    const guest = await createGuest(guestApi, '隐私来宾');
    expect((await guestApi.post(`/api/invites/${room.inviteCode}/join`)).ok()).toBe(true);
    expect((await request.post(`/api/rooms/${room.id}/credits`, {
      headers: { 'idempotency-key': `e2e-credit-${room.id}` },
      data: { playerId: guest.id, amount: 500 }
    })).ok()).toBe(true);

    await page.context().addCookies((await request.storageState()).cookies);
    const guestContext = await browser.newContext({ storageState: await guestApi.storageState() });
    const guestPage = await guestContext.newPage();
    await Promise.all([page.goto('/'), guestPage.goto(baseURL)]);
    await page.getByRole('button', { name: /隐私牌局/ }).click();
    await guestPage.getByRole('button', { name: /隐私牌局/ }).click();

    await expect(page.getByText('隐私来宾', { exact: true })).toBeVisible();
    await expect(guestPage.getByText('隐私房主', { exact: false })).toHaveCount(0);
    await expect(guestPage.locator('.memberRow').filter({ hasText: '隐私来宾（你）' })).toContainText('500');

    await page.getByRole('button', { name: /进入牌桌/ }).click();
    await guestPage.getByRole('button', { name: /进入牌桌/ }).click();
    await expect(page.locator('.seat.local')).toBeVisible();
    await expect(guestPage.locator('.seat.local')).toBeVisible();
    const start = page.getByRole('button', { name: /开始第一手/ });
    await expect(start).toBeEnabled();
    await start.click();

    await expect(page.locator('.holeCards .playingCard')).toHaveCount(2);
    await expect(guestPage.locator('.holeCards .playingCard')).toHaveCount(2);
    await expect(page.locator('.seat:not(.local) .playingCard')).toHaveCount(0);
    await expect(guestPage.locator('.seat:not(.local) .playingCard')).toHaveCount(0);
    const hostFold = page.locator('.foldButton');
    if (await hostFold.isEnabled()) await hostFold.click(); else await guestPage.locator('.foldButton').click();
    await expect(page.getByRole('button', { name: '手牌记录' })).toBeVisible();
    await page.getByRole('button', { name: '手牌记录' }).click();
    const historyItem = page.getByRole('button', { name: /第 1 手 · 弃牌结束/ });
    await expect(historyItem).toBeVisible();
    await historyItem.click();
    await expect(page.getByRole('heading', { name: '第 1 手回放' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '动作时间线' })).toBeVisible();
    await guestContext.close();
    await guestApi.dispose();
    expect(host.id).not.toBe(guest.id);
  });

  test('轮换邀请码后旧深链不能创建新成员', async ({ browser, page, request }) => {
    await createGuest(request, '轮换房主');
    const room = await createRoom(request, '轮换牌局');
    await page.context().addCookies((await request.storageState()).cookies);
    await page.goto('/');
    await page.getByRole('button', { name: /轮换牌局/ }).click();
    await page.getByRole('button', { name: '轮换邀请码' }).click();
    const inviteCode = page.locator('.inviteCard strong');
    await expect(inviteCode).not.toHaveText(room.inviteCode);
    const rotatedCode = await inviteCode.innerText();
    expect(rotatedCode).not.toBe(room.inviteCode);

    const guestContext = await browser.newContext();
    const guestPage = await guestContext.newPage();
    await guestPage.goto(`${baseURL}/join/${room.inviteCode}`);
    await guestPage.getByLabel('你的牌桌昵称').fill('轮换来宾');
    await guestPage.getByRole('button', { name: '开始我的私人牌局' }).click();
    await guestPage.getByRole('button', { name: '加入牌局' }).click();
    await expect(guestPage.getByText('邀请码无效、已关闭或房间已解散')).toBeVisible();

    await guestPage.getByLabel('邀请码').fill(rotatedCode);
    await guestPage.getByRole('button', { name: '加入牌局' }).click();
    await expect(guestPage.getByText('INVITED PLAYER', { exact: true })).toBeVisible();
    await guestContext.close();
  });

  test('暂停的空闲牌局可以立即解散并返回房间列表', async ({ page, request }) => {
    await createGuest(request, '解散房主');
    await createRoom(request, '解散牌局');
    await page.context().addCookies((await request.storageState()).cookies);
    await page.goto('/');
    await page.getByRole('button', { name: /解散牌局/ }).click();
    await page.getByRole('button', { name: '暂停牌局' }).click();
    const dissolve = page.getByRole('button', { name: '解散房间并生成结算记录' });
    await expect(dissolve).toBeEnabled();
    page.once('dialog', (dialog) => dialog.accept());
    await dissolve.click();
    await expect(page.getByRole('heading', { name: '我的牌局' })).toBeVisible();
    await expect(page.getByRole('button', { name: /解散牌局/ })).toHaveCount(0);
  });

  test('手牌中途入桌会显示候补提示并在结算边界自动坐入下一手', async ({ browser, page, request }) => {
    await createGuest(request, '候补房主');
    const room = await createRoom(request, '候补牌局');
    const guestApi = await apiRequest.newContext({ baseURL });
    const guest = await createGuest(guestApi, '在座来宾');
    await guestApi.post(`/api/invites/${room.inviteCode}/join`);
    await request.post(`/api/rooms/${room.id}/credits`, { headers: { 'idempotency-key': `seat-guest-${room.id}` }, data: { playerId: guest.id, amount: 500 } });
    await page.context().addCookies((await request.storageState()).cookies);
    const guestContext = await browser.newContext({ storageState: await guestApi.storageState() });
    const guestPage = await guestContext.newPage();
    await Promise.all([page.goto('/'), guestPage.goto(baseURL)]);
    await page.getByRole('button', { name: /候补牌局/ }).click();
    await guestPage.getByRole('button', { name: /候补牌局/ }).click();
    await page.getByRole('button', { name: /进入牌桌/ }).click();
    await guestPage.getByRole('button', { name: /进入牌桌/ }).click();
    await page.getByRole('button', { name: /开始第一手/ }).click();
    await expect(page.locator('.holeCards .playingCard')).toHaveCount(2);

    const waitingApi = await apiRequest.newContext({ baseURL });
    const waiting = await createGuest(waitingApi, '候补玩家');
    await waitingApi.post(`/api/invites/${room.inviteCode}/join`);
    await request.post(`/api/rooms/${room.id}/credits`, { headers: { 'idempotency-key': `seat-waiting-${room.id}` }, data: { playerId: waiting.id, amount: 500 } });
    const waitingContext = await browser.newContext({ storageState: await waitingApi.storageState() });
    const waitingPage = await waitingContext.newPage();
    await waitingPage.goto(baseURL);
    await waitingPage.getByRole('button', { name: /候补牌局/ }).click();
    await waitingPage.getByRole('button', { name: /进入牌桌/ }).click();
    await expect(waitingPage.locator('.waitingNotice')).toContainText('正在候补座位');
    await expect(waitingPage.locator('.holeCards .playingCard')).toHaveCount(0);

    if (await page.locator('.foldButton').isEnabled()) await page.locator('.foldButton').click(); else await guestPage.locator('.foldButton').click();
    await expect(waitingPage.locator('.waitingNotice')).toHaveCount(0);
    await expect(waitingPage.locator('.holeCards .playingCard')).toHaveCount(2, { timeout: 8_000 });

    await Promise.all([guestContext.close(), waitingContext.close(), guestApi.dispose(), waitingApi.dispose()]);
  });

  test('6 人和 9 人桌在桌面与移动视口中保持本地玩家底部和物理座位稳定', async ({ page, request }) => {
    await createGuest(request, '布局房主');
    await createRoom(request, '六人布局', 6);
    await createRoom(request, '九人布局', 9);
    await page.context().addCookies((await request.storageState()).cookies);
    await page.goto('/');

    for (const [name, size] of [['六人布局', 6], ['九人布局', 9]] as const) {
      await page.getByRole('button', { name: new RegExp(name) }).click();
      await page.getByRole('button', { name: /进入牌桌/ }).click();
      const table = page.locator(`.tableArea[data-table-size="${size}"]`);
      await expect(table.locator('.seat')).toHaveCount(size);
      await expect(table.locator('.seat.local')).toHaveAttribute('data-visual-offset', '0');
      expect(await table.locator('.seat').evaluateAll((seats) => seats.map((seat) => seat.getAttribute('data-physical-seat')))).toEqual(
        Array.from({ length: size }, (_, index) => String(index + 1))
      );
      await page.getByRole('button', { name: '返回房间' }).click();
      await page.getByRole('button', { name: '返回我的牌局' }).click();
    }
  });
});
