import { afterEach, describe, expect, it, vi } from 'vitest';
import { RiverStore } from './store.js';
import { TableScheduler } from './table-scheduler.js';

afterEach(() => vi.useRealTimers());

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
  return { store, room, host };
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
    expect(scheduler.snapshot(room.id, host.id).timing.nextHandStartsAt).toBe(Date.parse('2026-08-28T12:00:22Z'));

    await vi.advanceTimersByTimeAsync(2_000);
    expect(store.tables.get(room.id)?.snapshot(host.id).hand).toMatchObject({ number: 2, status: 'active' });
    expect(scheduler.snapshot(room.id, host.id).timing.actionDeadlineAt).toBe(Date.parse('2026-08-28T12:00:42Z'));
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
      nextHandStartsAt: Date.parse('2026-08-28T12:00:05Z')
    });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(table.snapshot(host.id).hand).toMatchObject({ number: 2, status: 'active' });
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
});
