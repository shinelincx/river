import { describe, expect, it } from 'vitest';
import { RiverStore } from './store.js';

describe('room permissions and append-only ledger', () => {
  it('allows invited members but only the host may credit them idempotently', () => {
    const store = new RiverStore();
    const host = store.createGuest('Host').player;
    const guest = store.createGuest('Guest').player;
    const room = store.createRoom(host.id, { name: 'Test', maxSeats: 6, smallBlind: 20, initialChips: 1500 });
    store.joinByCode(guest.id, room.inviteCode);
    expect(() => store.credit(guest.id, room.id, guest.id, 100, 'nope')).toThrow('仅房主');
    const first = store.credit(host.id, room.id, guest.id, 500, 'credit-1');
    const duplicate = store.credit(host.id, room.id, guest.id, 500, 'credit-1');
    const hostTopUp = store.credit(host.id, room.id, host.id, 300, 'host-credit');
    expect(duplicate.id).toBe(first.id);
    expect(hostTopUp.playerId).toBe(host.id);
    expect(store.roomView(room.id, host.id).members.find((member) => member.id === host.id)?.chips).toBe(1800);
    expect(store.roomView(room.id, guest.id).members.find((member) => member.id === guest.id)?.chips).toBe(500);
  });

  it('closes invitations and preserves a private settlement at dissolution', () => {
    const store = new RiverStore();
    const host = store.createGuest('Host').player;
    const room = store.createRoom(host.id, { name: 'Test', maxSeats: 6, smallBlind: 20, initialChips: 1500 });
    store.dissolve(host.id, room.id);
    expect(store.rooms.get(room.id)?.status).toBe('dissolved');
    expect(store.historyFor(host.id)[0]?.finalChips).toBe(1500);
    expect(() => store.joinByCode(host.id, room.inviteCode)).toThrow('邀请码无效');
  });

  it('reports current table stacks instead of cumulative credited chips', () => {
    const store = new RiverStore();
    const host = store.createGuest('Host').player;
    const guest = store.createGuest('Guest').player;
    const room = store.createRoom(host.id, { name: 'Live stacks', maxSeats: 6, smallBlind: 10, initialChips: 500 });
    store.joinByCode(guest.id, room.inviteCode);
    store.credit(host.id, room.id, guest.id, 500, 'guest-credit');
    const table = store.tableFor(room.id, host.id);
    store.tableFor(room.id, guest.id);
    store.startTable(host.id, room.id);

    table.takeAction(table.snapshot(host.id).hand!.currentPlayerId!, { type: 'fold' });
    const currentStacks = new Map(table.players.map((player) => [player.id, player.stack]));
    const members = store.roomView(room.id, host.id).members;

    expect(members.map((member) => [member.id, member.chips])).toEqual(
      expect.arrayContaining([...currentStacks])
    );
    expect(members.some((member) => member.chips !== 500)).toBe(true);
  });
});
