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
  test('已有可继续的私人房时，主页优先提供继续牌局入口', async ({ page, request }) => {
    await createGuest(request, '继续牌局房主');
    await createRoom(request, '周末牌局');
    await page.context().addCookies((await request.storageState()).cookies);
    await page.goto('/');

    const hero = page.locator('.hero');
    await expect(hero.getByRole('button', { name: '继续牌局' })).toBeVisible();
    await expect(hero).toContainText('继续 周末牌局');
    await expect(page.locator('.roomCard')).toContainText('牌局进行中');
    await hero.getByRole('button', { name: '继续牌局' }).click();
    await expect(page.locator('.roomTop').getByRole('heading', { name: '周末牌局' })).toBeVisible();
  });

  test('创建房间时会从失效的设备会话恢复，而不是停留在邀请码生成失败状态', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('你的牌桌昵称').fill('会话恢复房主');
    await page.getByRole('button', { name: '开始我的私人牌局' }).click();
    await expect(page.getByRole('button', { name: '创建房间', exact: true })).toBeVisible();

    await page.route('**/api/rooms', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: '请先创建游客身份' }) });
        return;
      }
      await route.continue();
    });

    await page.getByRole('button', { name: '创建房间', exact: true }).click();
    await page.getByRole('button', { name: '生成邀请码', exact: true }).click();

    await expect(page.getByRole('heading', { name: 'River Table', exact: true })).toBeVisible();
    await expect(page.getByLabel('你的牌桌昵称')).toBeVisible();
  });

  test('新设备在有效邀请深链中创建游客身份并加入私人房', async ({ page, request }) => {
    await createGuest(request, '深链房主');
    const room = await createRoom(request, '深链牌局');

    await page.goto(`/join/${room.inviteCode}`);
    await page.getByLabel('你的牌桌昵称').fill('深链来宾');
    await page.getByRole('button', { name: '开始我的私人牌局' }).click();

    const inviteInput = page.getByLabel('邀请码');
    await expect(inviteInput).toHaveValue(room.inviteCode);
    await page.getByRole('button', { name: '加入牌局' }).click();

    await expect(page.locator('.tableScreen')).toBeVisible();
    await expect(page.locator('.tableHeader')).toContainText('深链牌局');
    await expect(page).toHaveURL(`${baseURL}/`);
    await expect(page.locator('.seat.local .seatName')).toContainText('深链来宾');
  });

  test('窄屏和旧版长邀请码都不会遮挡复制操作', async ({ page, request }) => {
    await createGuest(request, '邀请码布局房主');
    const room = await createRoom(request, '邀请码布局');
    await page.context().addCookies((await request.storageState()).cookies);
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto('/');
    await page.getByRole('button', { name: /邀请码布局/ }).click();

    const inviteCode = page.locator('.inviteCode');
    await expect(inviteCode).toHaveText(room.inviteCode);
    expect(room.inviteCode).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    await inviteCode.evaluate((element) => { element.textContent = 'RIVER-ABCDEFGHIJKLMNOPQRSTUVWXYZ_1234567890-LONG-COMPATIBLE-CODE'; });

    const card = page.locator('.inviteCard');
    const copyCode = page.getByRole('button', { name: '复制邀请码' });
    const copyLink = page.getByRole('button', { name: '复制链接' });
    await expect(copyCode).toBeVisible();
    await expect(copyLink).toBeVisible();
    const [cardBox, codeButtonBox, linkButtonBox] = await Promise.all([card.boundingBox(), copyCode.boundingBox(), copyLink.boundingBox()]);
    expect(cardBox).not.toBeNull();
    expect(codeButtonBox).not.toBeNull();
    expect(linkButtonBox).not.toBeNull();
    expect(codeButtonBox!.x + codeButtonBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width);
    expect(linkButtonBox!.x + linkButtonBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width);
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

    await expect(page.locator('.topbar')).toHaveCount(0);
    await expect(guestPage.locator('.topbar')).toHaveCount(0);
    await expect(page.getByText('房主可为自己和其他玩家补充积分')).toHaveCount(0);
    const hostCredit = page.getByRole('spinbutton', { name: '向 隐私房主 补码', exact: true });
    await expect(hostCredit).toHaveValue('2000');
    await expect(hostCredit).toHaveAttribute('step', '2000');
    const stepperGeometry = await hostCredit.locator('..').evaluate((stepper) => {
      const plus = stepper.querySelector<HTMLButtonElement>('button:last-child');
      if (!plus) throw new Error('missing plus button');
      const stepperBox = stepper.getBoundingClientRect();
      const plusBox = plus.getBoundingClientRect();
      return { stepperRight: stepperBox.right, plusRight: plusBox.right, plusWidth: plusBox.width };
    });
    expect(stepperGeometry.plusWidth).toBe(42);
    expect(stepperGeometry.plusRight).toBeCloseTo(stepperGeometry.stepperRight - 1, 0);
    await page.getByLabel('向 隐私房主 补码增加 2,000').click();
    await expect(hostCredit).toHaveValue('4000');
    await page.getByLabel('向 隐私房主 补码减少 2,000').click();
    await expect(hostCredit).toHaveValue('2000');
    await expect(page.getByRole('button', { name: '补码', exact: true })).toHaveCount(2);
    await expect(page.locator('.memberRole.host')).toHaveText('房主');
    const hostGuestRow = page.locator('.memberRow').filter({ hasText: '隐私来宾' });
    await expect(hostGuestRow.locator('.memberRole.member')).toHaveText('成员');
    await expect(hostGuestRow.locator('.memberInfo small')).toHaveCount(0);
    await expect(hostGuestRow.locator('.memberIdentity').getByRole('button', { name: '移除' })).toBeVisible();
    await expect(page.getByText('隐私来宾', { exact: true })).toBeVisible();
    await expect(guestPage.getByText('隐私房主', { exact: false })).toHaveCount(0);
    await expect(guestPage.locator('.memberRow').filter({ hasText: '隐私来宾' })).toContainText('500');

    await page.getByRole('button', { name: /进入牌桌/ }).click();
    await guestPage.getByRole('button', { name: /进入牌桌/ }).click();
    await expect(page.locator('.seat.local')).toBeVisible();
    await expect(guestPage.locator('.seat.local')).toBeVisible();
    const hostSeatFor = (observer: typeof page) => observer.locator('.seat').filter({ hasText: '隐私房主' });
    const guestSeatFor = (observer: typeof page) => observer.locator('.seat').filter({ hasText: '隐私来宾' });
    await expect(hostSeatFor(page)).toHaveAttribute('data-physical-seat', '1');
    await expect(hostSeatFor(page)).toHaveAttribute('data-visual-offset', '0');
    await expect(guestSeatFor(page)).toHaveAttribute('data-physical-seat', '2');
    await expect(guestSeatFor(page)).toHaveAttribute('data-visual-offset', '1');
    await expect(hostSeatFor(guestPage)).toHaveAttribute('data-physical-seat', '1');
    await expect(hostSeatFor(guestPage)).toHaveAttribute('data-visual-offset', '5');
    await expect(guestSeatFor(guestPage)).toHaveAttribute('data-physical-seat', '2');
    await expect(guestSeatFor(guestPage)).toHaveAttribute('data-visual-offset', '0');
    const start = page.getByRole('button', { name: /开始第一手/ });
    await expect(start).toBeEnabled();
    await start.click();

    await expect(page.locator('.holeCards .playingCard')).toHaveCount(2);
    await expect(guestPage.locator('.holeCards .playingCard')).toHaveCount(2);
    await expect(page.locator('.seat:not(.local) .playingCard')).toHaveCount(0);
    await expect(guestPage.locator('.seat:not(.local) .playingCard')).toHaveCount(0);
    const visibleActionDocks = (await page.locator('.actionDock').count()) + (await guestPage.locator('.actionDock').count());
    expect(visibleActionDocks).toBe(1);
    const actingPage = await page.locator('.foldButton').count() ? page : guestPage;
    const observingPage = actingPage === page ? guestPage : page;
    await expect(actingPage.locator('.actionControlCluster > .seatCountdown.panelTimer')).toBeVisible();
    await expect(actingPage.locator('.actionDock .seatCountdown.panelTimer')).toHaveCount(0);
    await expect(actingPage.locator('.actionDock .actionTurnLabel')).toHaveCount(0);
    await expect(observingPage.locator('.seat.activeTurn .seatCountdown.seatTimer')).toBeVisible();
    const timerStyle = await actingPage.locator('.actionControlCluster > .seatCountdown.panelTimer').evaluate((timer) => {
      const style = getComputedStyle(timer);
      timer.classList.add('urgent');
      const urgentStyle = getComputedStyle(timer);
      return { borderRadius: style.borderRadius, borderTopWidth: style.borderTopWidth, backgroundColor: style.backgroundColor, fontSize: getComputedStyle(timer.querySelector('strong')!).fontSize, urgentColor: urgentStyle.color, urgentFontWeight: urgentStyle.fontWeight, urgentTextShadow: urgentStyle.textShadow, urgentBoxShadow: urgentStyle.boxShadow };
    });
    expect(timerStyle.borderRadius).toBe('999px');
    expect(timerStyle.borderTopWidth).toBe('0px');
    expect(timerStyle.backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(timerStyle.fontSize).toBe('23px');
    expect(timerStyle.urgentColor).toBe('rgb(255, 98, 92)');
    expect(timerStyle.urgentFontWeight).toBe('900');
    expect(timerStyle.urgentTextShadow).not.toBe('none');
    expect(timerStyle.urgentBoxShadow).toBe('none');
    const floatingPanelLayout = await actingPage.locator('.tableScreen').evaluate((screen) => {
      const tableArea = screen.querySelector<HTMLElement>('.tableArea');
      const dock = screen.querySelector<HTMLElement>('.actionDock');
      const timer = screen.querySelector<HTMLElement>('.actionControlCluster > .seatCountdown.panelTimer');
      const cards = screen.querySelector<HTMLElement>('.holeCards');
      if (!tableArea || !dock || !timer || !cards) throw new Error('missing table layout elements');
      const tableBox = tableArea.getBoundingClientRect();
      const dockBox = dock.getBoundingClientRect();
      const timerBox = timer.getBoundingClientRect();
      const cardsBox = cards.getBoundingClientRect();
      return { position: getComputedStyle(dock).position, bottom: getComputedStyle(dock).bottom, backgroundColor: getComputedStyle(dock).backgroundColor, backdropFilter: getComputedStyle(dock).backdropFilter, tableBottom: tableBox.bottom, dockTop: dockBox.top, dockBottom: dockBox.bottom, timerBottom: timerBox.bottom, cardsTop: cardsBox.top };
    });
    expect(floatingPanelLayout.position).toBe('relative');
    expect(floatingPanelLayout.bottom).toBe('0px');
    expect(floatingPanelLayout.backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(floatingPanelLayout.backdropFilter).toBe('none');
    expect(floatingPanelLayout.timerBottom).toBeLessThanOrEqual(floatingPanelLayout.dockTop);
    expect(floatingPanelLayout.dockTop).toBeLessThan(floatingPanelLayout.tableBottom);
    expect(floatingPanelLayout.dockBottom).toBeLessThanOrEqual(floatingPanelLayout.cardsTop);
    await expect(actingPage.locator('[data-quick-bet]')).toHaveCount(4);
    const directRaise = actingPage.locator('[data-quick-bet]:enabled').first();
    await expect(directRaise).toBeEnabled();
    await directRaise.click();
    await expect(actingPage.locator('.actionDock')).toHaveCount(0);
    const respondingPage = await page.locator('.foldButton').count() ? page : guestPage;
    await respondingPage.locator('.foldButton').click();
    await expect(page.locator('.seatAvatar.seatStateWIN')).toHaveCount(1);
    await expect(guestPage.locator('.seatAvatar.seatStateWIN')).toHaveCount(1);
    await expect(page.locator('.settlementBanner')).toContainText('赢得');
    await expect(page.locator('.settlementBanner')).not.toContainText('本手赢家');
    const settlementStyle = await page.locator('.settlementBanner').evaluate((banner) => {
      const style = getComputedStyle(banner);
      return { backgroundColor: style.backgroundColor, borderTopWidth: style.borderTopWidth, boxShadow: style.boxShadow };
    });
    expect(settlementStyle.backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(settlementStyle.borderTopWidth).toBe('0px');
    expect(settlementStyle.boxShadow).toBe('none');
    const potLayout = await page.locator('.pot').evaluate((pot) => {
      const label = pot.querySelector<HTMLElement>('span')!;
      const amount = pot.querySelector<HTMLElement>('b')!;
      return { borderTopWidth: getComputedStyle(pot).borderTopWidth, labelBottom: label.getBoundingClientRect().bottom, amountTop: amount.getBoundingClientRect().top };
    });
    expect(potLayout.borderTopWidth).toBe('0px');
    expect(potLayout.labelBottom).toBeLessThanOrEqual(potLayout.amountTop);
    const nextHandClock = page.locator('.nextHandClock[data-phase="next-hand"]');
    await expect(nextHandClock).toHaveText(/^\d+\s*s$/);
    const nextHandLayout = await page.locator('.tableArea').evaluate((tableArea) => {
      const clock = tableArea.querySelector<HTMLElement>('.nextHandClock[data-phase="next-hand"]');
      const pot = tableArea.querySelector<HTMLElement>('.pot');
      if (!clock || !pot) throw new Error('missing next-hand layout elements');
      return {
        borderTopWidth: getComputedStyle(clock).borderTopWidth,
        clockBottom: clock.getBoundingClientRect().bottom,
        potTop: pot.getBoundingClientRect().top,
      };
    });
    expect(nextHandLayout.borderTopWidth).toBe('0px');
    expect(nextHandLayout.clockBottom).toBeLessThanOrEqual(nextHandLayout.potTop);
    const verifyAudit = page.getByRole('button', { name: '验证本手发牌' });
    await expect(verifyAudit).toBeVisible();
    await verifyAudit.click();
    await expect(page.getByRole('button', { name: /本地验证与服务端交叉校验通过/ })).toBeVisible();
    await expect(page.getByRole('button', { name: '手牌记录' })).toBeVisible();
    await page.getByRole('button', { name: '手牌记录' }).click();
    const historyItem = page.getByRole('button', { name: '查看第 1 手牌回放' });
    await expect(historyItem).toBeVisible();
    await expect(historyItem).toContainText('我的盈亏');
    await expect(historyItem).toContainText('底池');
    await historyItem.click();
    await expect(page.getByRole('heading', { name: '第 1 手回放' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '玩家结果' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '行动过程' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '翻牌前' })).toBeVisible();
    await expect(page.getByText(/支付小盲/)).toBeVisible();
    await expect(page.locator('.replayMoment strong').filter({ hasText: '弃牌' })).toBeVisible();
    const replaySheet = page.locator('.sheet');
    await replaySheet.evaluate((sheet) => sheet.scrollTo({ top: sheet.scrollHeight }));
    const scrollTop = await replaySheet.evaluate((sheet) => sheet.scrollTop);
    expect(scrollTop).toBeGreaterThan(0);
    await page.waitForTimeout(5_500);
    await expect.poll(() => replaySheet.evaluate((sheet) => sheet.scrollTop)).toBeGreaterThanOrEqual(scrollTop);
    await page.getByText('审计与技术详情', { exact: true }).click();
    const downloadStarted = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载验证包' }).click();
    expect((await downloadStarted).suggestedFilename()).toBe('river-hand-1-verification.json');
    await page.getByRole('button', { name: '关闭' }).click();
    await guestContext.close();
    await expect(page.getByRole('timer', { name: /重连宽限期剩余/ })).toBeVisible();
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
    await expect(guestPage.locator('.tableScreen')).toBeVisible();
    await guestContext.close();
  });

  test('暂停的空闲牌局可以立即关闭并保留最终积分', async ({ page, request }) => {
    await createGuest(request, '解散房主');
    await createRoom(request, '解散牌局');
    await page.context().addCookies((await request.storageState()).cookies);
    await page.goto('/');
    await page.getByRole('button', { name: /解散牌局/ }).click();
    await page.getByRole('button', { name: '暂停牌局' }).click();
    const close = page.getByRole('button', { name: '关闭房间并保留最终积分记录' });
    await expect(close).toBeEnabled();
    page.once('dialog', (dialog) => dialog.accept());
    await close.click();
    await expect(page.getByRole('heading', { name: '成员最终积分' })).toBeVisible();
    await expect(page.getByRole('button', { name: '关闭房间并保留最终积分记录' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '进入牌桌' })).toHaveCount(0);
    await expect(page.getByText('1,500', { exact: true })).toBeVisible();
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

    const actingPage = await page.locator('.foldButton').count() ? page : guestPage;
    await actingPage.locator('.foldButton').click();
    await expect(waitingPage.locator('.waitingNotice')).toHaveCount(0);
    await expect(waitingPage.locator('.holeCards .playingCard')).toHaveCount(2, { timeout: 8_000 });

    await Promise.all([guestContext.close(), waitingContext.close(), guestApi.dispose(), waitingApi.dispose()]);
  });

  test('6 人和 9 人桌在桌面与移动视口中保持本地玩家底部和物理座位稳定', async ({ page, request }) => {
    await createGuest(request, '六人布局房主');
    await createRoom(request, '六人布局', 6);
    const nineSeatApi = await apiRequest.newContext({ baseURL });
    await createGuest(nineSeatApi, '九人布局房主');
    await createRoom(nineSeatApi, '九人布局', 9);
    const layouts = [
      { name: '六人布局', size: 6 as const, storageState: await request.storageState() },
      { name: '九人布局', size: 9 as const, storageState: await nineSeatApi.storageState() }
    ];
    const feltStyles = new Map<number, { top: string; width: string; height: string; borderRadius: string }>();

    for (const { name, size, storageState } of layouts) {
      await page.context().clearCookies();
      await page.context().addCookies(storageState.cookies);
      await page.goto('/');
      await page.getByRole('button', { name: new RegExp(name) }).click();
      await page.getByRole('button', { name: /进入牌桌/ }).click();
      const table = page.locator(`.tableArea[data-table-size="${size}"]`);
      await expect(table.locator('.seat')).toHaveCount(size);
      await expect(table.locator('.seat.local')).toHaveAttribute('data-visual-offset', '0');
      await expect(table.locator('.seatAvatar').first()).toHaveCSS('border-top-width', '3px');
      expect(await table.locator('.seat').evaluateAll((seats) => seats.map((seat) => seat.getAttribute('data-physical-seat')))).toEqual(
        Array.from({ length: size }, (_, index) => String(index + 1))
      );
      const rightDealerStyles = await table.evaluate((tableArea, offsets: number[]) => offsets.map((offset) => {
        const seat = document.createElement('div');
        seat.className = 'seat';
        seat.dataset.visualOffset = String(offset);
        const avatarWrap = document.createElement('span');
        avatarWrap.className = 'seatAvatarWrap';
        const dealer = document.createElement('span');
        dealer.className = 'dealerButton';
        avatarWrap.append(dealer);
        seat.append(avatarWrap);
        tableArea.append(seat);
        const style = getComputedStyle(dealer);
        const result = { left: style.left, transform: style.transform };
        seat.remove();
        return result;
      }), size === 6 ? [4, 5] : [4, 5, 6, 7, 8]);
      expect(rightDealerStyles).toEqual(rightDealerStyles.map(() => ({ left: '-14px', transform: 'matrix(1, 0, 0, 1, 0, -12)' })));
      feltStyles.set(size, await table.locator('.felt').evaluate((felt) => {
        const style = getComputedStyle(felt);
        return { top: style.top, width: style.width, height: style.height, borderRadius: style.borderTopLeftRadius };
      }));
      if (size === 6) {
        const sixSeatGeometry = await table.evaluate((tableArea) => {
          const tableBox = tableArea.getBoundingClientRect();
          const box = (selector: string) => (tableArea.querySelector<HTMLElement>(selector) ?? tableArea).getBoundingClientRect();
          const felt = tableArea.querySelector<HTMLElement>('.felt');
          return {
            feltBorder: felt ? getComputedStyle(felt).borderTopWidth : '',
            feltOutline: felt ? getComputedStyle(felt).outlineStyle : '',
            leftGap: box('.relativeSeat1').top - box('.relativeSeat2').top,
            rightGap: box('.relativeSeat5').top - box('.relativeSeat4').top,
            leftBottomInset: tableBox.bottom - box('.relativeSeat1').bottom,
            rightBottomInset: tableBox.bottom - box('.relativeSeat5').bottom,
            tableHeight: tableBox.height
          };
        });
        expect(sixSeatGeometry.feltBorder).toBe('0px');
        expect(sixSeatGeometry.feltOutline).toBe('none');
        expect(sixSeatGeometry.leftGap).toBeGreaterThan(sixSeatGeometry.tableHeight * .25);
        expect(sixSeatGeometry.rightGap).toBeGreaterThan(sixSeatGeometry.tableHeight * .25);
        expect(sixSeatGeometry.leftBottomInset).toBeCloseTo(sixSeatGeometry.tableHeight * .26, 0);
        expect(sixSeatGeometry.rightBottomInset).toBeCloseTo(sixSeatGeometry.tableHeight * .26, 0);
      }
      if (size === 9) {
        const nineSeatGeometry = await table.evaluate((tableArea) => {
          const tableBox = tableArea.getBoundingClientRect();
          const seat = (selector: string) => (tableArea.querySelector<HTMLElement>(selector) ?? tableArea).getBoundingClientRect();
          const movedSeat = seat('.relativeSeat1');
          const leftUpperSeat = seat('.relativeSeat4');
          const rightOfMovedSeat = seat('.relativeSeat5');
          const rightSeats = ['.relativeSeat6', '.relativeSeat7', '.relativeSeat8'].map((selector) => seat(selector));
          return {
            movedSeatTop: movedSeat.top,
            leftUpperSeatTop: leftUpperSeat.top,
            rightSeatCenter: rightOfMovedSeat.left + rightOfMovedSeat.width / 2 - tableBox.left,
            tableWidth: tableBox.width,
            rightInsets: rightSeats.map((seatBox) => tableBox.right - seatBox.right)
          };
        });
        expect(nineSeatGeometry.movedSeatTop).toBeLessThan(nineSeatGeometry.leftUpperSeatTop);
        expect(nineSeatGeometry.rightSeatCenter).toBeCloseTo(nineSeatGeometry.tableWidth * .6, 0);
        expect(nineSeatGeometry.rightInsets[1]).toBeCloseTo(nineSeatGeometry.rightInsets[0], 3);
        expect(nineSeatGeometry.rightInsets[2]).toBeCloseTo(nineSeatGeometry.rightInsets[0], 3);
      }
      await page.getByRole('button', { name: '返回房间' }).click();
      await page.getByRole('button', { name: '返回我的牌局' }).click();
    }
    await nineSeatApi.dispose();
    expect(feltStyles.get(6)).toEqual(feltStyles.get(9));
  });
});
