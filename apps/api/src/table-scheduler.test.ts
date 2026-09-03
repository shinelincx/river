import { afterEach, describe, expect, it, vi } from 'vitest';
import { RiverStore } from './store.js';
import { TableScheduler } from './table-scheduler.js';

afterEach(() => vi.useRealTimers());

function completePreparation(store: RiverStore, roomId: string): void {
  const table = store.tables.get(roomId)!;
  const preparing = table.snapshot('system').preparing;
  if (!preparing) return;
  for (const playerId of preparing.participantIds) {
    table.setShuffleContribution(playerId, preparing.id, `scheduler-test-entropy-${playerId}`);
  }
}

function startedHeadsUpTable() {
  const store = new RiverStore();
  const host = store.createGuest('Host').player;
  const guest = store.createGuest('Guest').player;
  const room = store.createRoom(host.id, { name: 'Timer test', maxSeats: 6, smallBlind: 10, initialChips: 500 });
  store.joinByCode(guest.id, room.inviteCode);
  store.credit(host.id, room.id, guest.id, 500, 'timer-test-credit');
  store.tableFor(room.id, host.id);
  store.tableFor(room.id, guest.id);
  store.startTable(host.id, room.id);
  completePreparation(store, room.id);
  return { store, room, host };
}

function startedFullTableWithWaitingPlayer() {
  const store = new RiverStore();
  const host = store.createGuest('Host').player;
  const room = store.createRoom(host.id, { name: 'Full timer test', maxSeats: 6, smallBlind: 10, initialChips: 500 });
  const seated = [host];
  for (const nickname of ['Guest 1', 'Guest 2', 'Guest 3', 'Guest 4', 'Guest 5']) {
    const player = store.createGuest(nickname).player;
    store.joinByCode(player.id, room.inviteCode);
    store.credit(host.id, room.id, player.id, 500, `timer-test-credit-${player.id}`);
    seated.push(player);
  }
  for (const player of seated) store.tableFor(room.id, player.id);
  store.startTable(host.id, room.id);
  completePreparation(store, room.id);

  const waiting = store.createGuest('Waiting').player;
  store.joinByCode(waiting.id, room.inviteCode);
  store.credit(host.id, room.id, waiting.id, 500, `timer-test-credit-${waiting.id}`);
  store.tableFor(room.id, waiting.id);
  return { store, room, host, waiting };
}

describe('table scheduler', () => {
  it('starts the next hand after a timeout settles the current hand', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T12:00:00Z'));
    const { store, room, host } = startedHeadsUpTable();
    const scheduler = new TableScheduler(store, async () => undefined);

    await scheduler.join(room.id);
    expect(scheduler.snapshot(room.id, host.id).timing).toMatchObject({
      serverNow: Date.parse('2026-08-28T12:00:00Z'),
      actionDeadlineAt: Date.parse('2026-08-28T12:00:20Z')
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(store.tables.get(room.id)?.snapshot(host.id).hand).toMatchObject({ number: 1, status: 'settled' });
    expect(scheduler.snapshot(room.id, host.id).timing.nextHandStartsAt).toBe(Date.parse('2026-08-28T12:00:25Z'));

    await vi.advanceTimersByTimeAsync(5_000);
    completePreparation(store, room.id);
    await scheduler.stateChanged(room.id);
    expect(store.tables.get(room.id)?.snapshot(host.id).hand).toMatchObject({ number: 2, status: 'active' });
    expect(scheduler.snapshot(room.id, host.id).timing.actionDeadlineAt).toBe(Date.parse('2026-08-28T12:00:45Z'));
    scheduler.close();
  });

  it('waits for two funded players and resumes after a top-up', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T12:00:00Z'));
    const { store, room, host } = startedHeadsUpTable();
    const table = store.tables.get(room.id)!;
    const scheduler = new TableScheduler(store, async () => undefined);

    await scheduler.join(room.id);
    table.timeout(table.snapshot(host.id).hand!.currentPlayerId!);
    const bustedPlayer = table.players.find((player) => player.id === host.id)!;
    const fundedPlayer = table.players.find((player) => player.id !== host.id)!;
    bustedPlayer.stack = 0;
    fundedPlayer.stack = 1_000;

    await scheduler.stateChanged(room.id);
    expect(table.snapshot(host.id).hand).toMatchObject({ number: 1, status: 'settled' });
    expect(scheduler.snapshot(room.id, host.id).timing).toMatchObject({ waitingForPlayers: true });
    expect(scheduler.snapshot(room.id, host.id).timing.nextHandStartsAt).toBeUndefined();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(table.snapshot(host.id).hand).toMatchObject({ number: 1, status: 'settled' });

    table.topUp(host.id, 500);
    await scheduler.fundingChanged(room.id);
    expect(scheduler.snapshot(room.id, host.id).timing).toMatchObject({
      waitingForPlayers: false,
      nextHandStartsAt: Date.parse('2026-08-28T12:00:08Z')
    });

    await vi.advanceTimersByTimeAsync(5_000);
    completePreparation(store, room.id);
    await scheduler.stateChanged(room.id);
    expect(table.snapshot(host.id).hand).toMatchObject({ number: 2, status: 'active' });
    scheduler.close();
  });

  it('promotes a funded waiting player before deciding whether the next hand can start', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T12:00:00Z'));
    const { store, room, host } = startedHeadsUpTable();
    const originalGuest = store.roomView(room.id, host.id).members.find((member) => member.id !== host.id)!;
    const waiting = store.createGuest('Waiting').player;
    store.joinByCode(waiting.id, room.inviteCode);
    store.credit(host.id, room.id, waiting.id, 500, 'waiting-credit');
    const table = store.tableFor(room.id, waiting.id);
    expect(table.players.find((player) => player.id === waiting.id)).toMatchObject({ seat: 0, participation: 'waiting' });
    store.removeMember(host.id, room.id, originalGuest.id);
    table.takeAction(table.snapshot(host.id).hand!.currentPlayerId!, { type: 'fold' });
    store.maybeFinalize(room.id);
    const scheduler = new TableScheduler(store, async () => undefined);

    await scheduler.stateChanged(room.id);

    expect(table.players.find((player) => player.id === waiting.id)).toMatchObject({ seat: expect.any(Number), participation: 'seated' });
    expect(table.players.find((player) => player.id === waiting.id)!.seat).toBeGreaterThan(0);
    expect(scheduler.snapshot(room.id, host.id).timing.nextHandStartsAt).toBe(Date.parse('2026-08-28T12:00:05Z'));
    scheduler.close();
  });

  it('does not reset the current action clock when credits change', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T12:00:00Z'));
    const { store, room, host } = startedHeadsUpTable();
    const scheduler = new TableScheduler(store, async () => undefined);

    await scheduler.join(room.id);
    await vi.advanceTimersByTimeAsync(5_000);
    store.tables.get(room.id)!.topUp(host.id, 100);
    await scheduler.fundingChanged(room.id);

    expect(scheduler.snapshot(room.id, host.id).timing.actionDeadlineAt).toBe(Date.parse('2026-08-28T12:00:20Z'));
    scheduler.close();
  });

  it('does not let a queued stale timeout remove the replacement actor clock', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T12:00:00Z'));
    const { store, room, host } = startedHeadsUpTable();
    let queuedWork: (() => Promise<unknown>) | undefined;
    const exclusive = async <T>(_roomId: string, work: () => Promise<T>): Promise<T> => {
      queuedWork = work;
      return undefined as T;
    };
    const scheduler = new TableScheduler(store, async () => undefined, 20_000, 2_000, 60_000, async () => undefined, exclusive);
    await scheduler.join(room.id);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(queuedWork).toBeDefined();
    const table = store.tables.get(room.id)!;
    const oldActor = table.snapshot(host.id).hand!.currentPlayerId!;
    table.takeAction(oldActor, { type: 'call' });
    await scheduler.stateChanged(room.id);
    expect(scheduler.snapshot(room.id, host.id).timing.actionDeadlineAt).toBe(Date.parse('2026-08-28T12:00:40Z'));

    await queuedWork!();

    expect(scheduler.snapshot(room.id, host.id).timing.actionDeadlineAt).toBe(Date.parse('2026-08-28T12:00:40Z'));
    scheduler.close();
  });

  it('does not let queued stale reconnect or next-hand callbacks override newer presence state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T12:00:00Z'));
    const { store, room, host } = startedHeadsUpTable();
    const queuedWork: Array<() => Promise<unknown>> = [];
    const exclusive = async <T>(_roomId: string, work: () => Promise<T>): Promise<T> => {
      queuedWork.push(work);
      return undefined as T;
    };
    const scheduler = new TableScheduler(store, async () => undefined, 20_000, 2_000, 60_000, async () => undefined, exclusive);
    const table = store.tables.get(room.id)!;
    const guest = table.players.find((player) => player.id !== host.id)!;

    table.takeAction(table.snapshot(host.id).hand!.currentPlayerId!, { type: 'fold' });
    await scheduler.stateChanged(room.id);
    await vi.advanceTimersByTimeAsync(2_000);
    const staleNextHand = queuedWork.shift()!;
    await scheduler.presenceChanged(room.id, guest.id, false);
    await staleNextHand();
    expect(table.snapshot(host.id).hand).toMatchObject({ number: 1, status: 'settled' });

    await vi.advanceTimersByTimeAsync(60_000);
    const staleReconnect = queuedWork.shift()!;
    await scheduler.presenceChanged(room.id, guest.id, true);
    await scheduler.presenceChanged(room.id, guest.id, false);
    const replacementDeadline = scheduler.exportTiming(room.id).reconnectDeadlines[guest.id];
    await staleReconnect();

    expect(guest.participation).toBe('seated');
    expect(scheduler.exportTiming(room.id).reconnectDeadlines[guest.id]).toBe(replacementDeadline);
    scheduler.close();
  });

  it('keeps committed state when a best-effort broadcast fails', async () => {
    const { store, room, host } = startedHeadsUpTable();
    const persist = vi.fn(async () => undefined);
    const scheduler = new TableScheduler(store, async () => { throw new Error('adapter unavailable'); }, 20_000, 2_000, 60_000, persist);

    await expect(scheduler.join(room.id)).resolves.toBeUndefined();

    expect(persist).toHaveBeenCalledWith(room.id);
    expect(scheduler.snapshot(room.id, host.id).timing.actionDeadlineAt).toEqual(expect.any(Number));
    scheduler.close();
  });

  it('restores the persisted action deadline instead of granting a fresh clock after restart', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T12:00:10Z'));
    const { store, room, host } = startedHeadsUpTable();
    const scheduler = new TableScheduler(store, async () => undefined);

    scheduler.restoreActionDeadline(room.id, Date.parse('2026-08-28T12:00:15Z'));

    expect(scheduler.snapshot(room.id, host.id).timing.actionDeadlineAt).toBe(Date.parse('2026-08-28T12:00:15Z'));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(store.tables.get(room.id)?.snapshot(host.id).hand).toMatchObject({ status: 'active' });
    await vi.advanceTimersByTimeAsync(1);
    expect(store.tables.get(room.id)?.snapshot(host.id).hand).toMatchObject({ status: 'settled' });
    scheduler.close();
  });

  it('restores reconnect and next-hand deadlines without granting fresh grace periods', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T12:00:10Z'));
    const { store, room, host } = startedHeadsUpTable();
    const table = store.tables.get(room.id)!;
    table.takeAction(table.snapshot(host.id).hand!.currentPlayerId!, { type: 'fold' });
    const disconnectedPlayer = table.players.find((player) => player.id !== host.id)!;
    disconnectedPlayer.connected = false;
    const scheduler = new TableScheduler(store, async () => undefined);

    scheduler.restoreTiming(room.id, {
      nextHandStartsAt: Date.parse('2026-08-28T12:00:12Z'),
      reconnectDeadlines: { [disconnectedPlayer.id]: Date.parse('2026-08-28T12:00:15Z') }
    });

    expect(scheduler.exportTiming(room.id)).toMatchObject({
      nextHandStartsAt: Date.parse('2026-08-28T12:00:12Z'),
      reconnectDeadlines: { [disconnectedPlayer.id]: Date.parse('2026-08-28T12:00:15Z') }
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(disconnectedPlayer.participation).toBe('sitting-out');
    expect(scheduler.exportTiming(room.id).reconnectDeadlines).toEqual({});
    scheduler.close();
  });

  it('normalizes process-local presence and grants exactly one reconnect grace after restart', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T12:00:00Z'));
    const { store, room } = startedHeadsUpTable();
    const table = store.tables.get(room.id)!;
    table.normalizePresenceAfterRestart();
    const scheduler = new TableScheduler(store, async () => undefined);

    scheduler.restoreTiming(room.id, { reconnectDeadlines: {} });

    expect(Object.values(scheduler.exportTiming(room.id).reconnectDeadlines)).toEqual([
      Date.parse('2026-08-28T12:01:00Z'),
      Date.parse('2026-08-28T12:01:00Z')
    ]);
    scheduler.close();
  });

  it('keeps the current hand clock but waits 60 seconds before sitting out a disconnected player', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T12:00:00Z'));
    const { store, room, host } = startedHeadsUpTable();
    const table = store.tables.get(room.id)!;
    const scheduler = new TableScheduler(store, async () => undefined);
    const disconnectedPlayerId = table.snapshot(host.id).hand!.currentPlayerId!;

    await scheduler.join(room.id);
    await scheduler.presenceChanged(room.id, disconnectedPlayerId, false);

    expect(scheduler.snapshot(room.id, host.id).timing).toMatchObject({
      actionDeadlineAt: Date.parse('2026-08-28T12:00:20Z'),
      reconnectDeadlines: { [disconnectedPlayerId]: Date.parse('2026-08-28T12:01:00Z') }
    });

    await vi.advanceTimersByTimeAsync(20_000);
    expect(table.snapshot(host.id).hand).toMatchObject({ number: 1, status: 'settled' });

    await vi.advanceTimersByTimeAsync(39_999);
    expect(table.snapshot(host.id).players.find((player) => player.id === disconnectedPlayerId)).toMatchObject({
      connected: false,
      participation: 'seated'
    });
    expect(table.snapshot(host.id).hand).toMatchObject({ number: 1, status: 'settled' });

    await vi.advanceTimersByTimeAsync(1);
    expect(table.snapshot(host.id).players.find((player) => player.id === disconnectedPlayerId)).toMatchObject({
      connected: false,
      participation: 'sitting-out',
      seat: 0
    });
    expect(scheduler.snapshot(room.id, host.id).timing.reconnectDeadlines).toEqual({});
    scheduler.close();
  });

  it('continues with connected players and assigns a timed-out seat to a waiting player', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T12:00:00Z'));
    const { store, room, host, waiting } = startedFullTableWithWaitingPlayer();
    const table = store.tables.get(room.id)!;
    const scheduler = new TableScheduler(store, async () => undefined);
    const disconnected = table.players.find((player) => player.id !== table.snapshot(host.id).hand!.currentPlayerId && player.id !== waiting.id)!;
    const releasedSeat = disconnected.seat;

    await scheduler.join(room.id);
    await scheduler.presenceChanged(room.id, disconnected.id, false);
    for (let turn = 0; table.snapshot(host.id).hand?.status === 'active' && turn < 24; turn += 1) {
      table.timeout(table.snapshot(host.id).hand!.currentPlayerId!);
    }
    expect(table.snapshot(host.id).hand).toMatchObject({ number: 1, status: 'settled' });

    await scheduler.stateChanged(room.id);
    expect(scheduler.snapshot(room.id, host.id).timing.nextHandStartsAt).toBe(Date.parse('2026-08-28T12:00:05Z'));
    await vi.advanceTimersByTimeAsync(5_000);
    completePreparation(store, room.id);
    await scheduler.stateChanged(room.id);
    expect(table.snapshot(host.id).hand).toMatchObject({ number: 2, status: 'active' });

    await vi.advanceTimersByTimeAsync(55_000);
    expect(table.snapshot(host.id).players.find((player) => player.id === disconnected.id)).toMatchObject({
      connected: false,
      participation: 'sitting-out',
      seat: 0
    });

    for (let turn = 0; table.snapshot(host.id).hand?.status === 'active' && turn < 24; turn += 1) {
      table.timeout(table.snapshot(host.id).hand!.currentPlayerId!);
    }
    await scheduler.stateChanged(room.id);
    expect(table.snapshot(host.id).players.find((player) => player.id === waiting.id)).toMatchObject({
      participation: 'seated',
      seat: releasedSeat
    });
    scheduler.close();
  });
});
