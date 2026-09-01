import { describe, expect, it } from 'vitest';
import type { PokerTable } from './game-engine.js';
import { RiverStore } from './store.js';

function completePreparation(table: PokerTable): void {
  const preparing = table.snapshot('system').preparing;
  if (!preparing) return;
  for (const playerId of preparing.participantIds) {
    table.setShuffleContribution(playerId, preparing.id, `store-test-entropy-${playerId}`);
  }
}

describe('room permissions and append-only ledger', () => {
  it('creates compact readable invite codes without reducing them below 60 bits of entropy', () => {
    const store = new RiverStore();
    const host = store.createGuest('Host').player;
    const room = store.createRoom(host.id, { name: 'Compact invite', maxSeats: 6, smallBlind: 10, initialChips: 500 });
    const guest = store.createGuest('Guest').player;

    expect(room.inviteCode).toMatch(/^RIVER-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(room.inviteCode).toHaveLength(20);
    expect(() => store.joinByCode(guest.id, room.inviteCode)).not.toThrow();
  });

  it('rejects unsupported seat counts and blind structures at runtime', () => {
    const store = new RiverStore();
    const host = store.createGuest('Host').player;

    expect(() => store.createRoom(host.id, { name: 'Bad seats', maxSeats: 7 as 6, smallBlind: 10, initialChips: 500 })).toThrow('座位数仅支持');
    expect(() => store.createRoom(host.id, { name: 'Bad blind', maxSeats: 6, smallBlind: 15, initialChips: 500 })).toThrow('盲注仅支持');
  });

  it('keeps room membership independent from physical seat capacity', () => {
    const store = new RiverStore();
    const host = store.createGuest('Host').player;
    const room = store.createRoom(host.id, { name: 'Waiting list', maxSeats: 6, smallBlind: 10, initialChips: 500 });
    const guests = Array.from({ length: 7 }, (_, index) => store.createGuest(`Guest ${index}`).player);

    for (const guest of guests) expect(() => store.joinByCode(guest.id, room.inviteCode)).not.toThrow();
    expect(store.roomView(room.id, host.id).members).toHaveLength(8);
  });

  it('credits an unseated member atomically and applies the ledger balance on later entry', () => {
    const store = new RiverStore();
    const host = store.createGuest('Host').player;
    const guest = store.createGuest('Guest').player;
    const room = store.createRoom(host.id, { name: 'Unseated credit', maxSeats: 6, smallBlind: 10, initialChips: 500 });
    store.joinByCode(guest.id, room.inviteCode);
    store.tableFor(room.id, host.id);

    expect(() => store.credit(host.id, room.id, guest.id, 250, 'unseated-credit')).not.toThrow();
    expect(store.tableFor(room.id, guest.id).players.find((player) => player.id === guest.id)?.stack).toBe(250);
    expect(store.ledgerFor(room.id, host.id).filter((entry) => entry.idempotencyKey === 'unseated-credit')).toHaveLength(1);
  });

  it('keeps a newly invited member at zero chips and out of the game until the host funds them', () => {
    const store = new RiverStore();
    const host = store.createGuest('Host').player;
    const guest = store.createGuest('Guest').player;
    const room = store.createRoom(host.id, { name: 'Zero start', maxSeats: 6, smallBlind: 20, initialChips: 1500 });

    store.joinByCode(guest.id, room.inviteCode);
    store.tableFor(room.id, host.id);
    store.tableFor(room.id, guest.id);

    const guestView = store.roomView(room.id, guest.id);
    expect(guestView.members).toEqual([expect.objectContaining({ id: guest.id, chips: 0 })]);
    expect(guestView.inviteCode).toBe('');
    expect(() => store.startTable(host.id, room.id)).toThrow('至少需要两位拥有积分的玩家入桌');

    store.credit(host.id, room.id, guest.id, 500, 'fund-guest');
    expect(() => store.startTable(host.id, room.id)).not.toThrow();
  });

  it('revokes a closed invitation permanently and issues a fresh credential when reopened', () => {
    const store = new RiverStore();
    const host = store.createGuest('Host').player;
    const guest = store.createGuest('Guest').player;
    const room = store.createRoom(host.id, { name: 'Revocation', maxSeats: 6, smallBlind: 10, initialChips: 500 });
    const oldCode = room.inviteCode;

    store.setInvite(host.id, room.id, false);
    expect(() => store.joinByCode(guest.id, oldCode)).toThrow('邀请码无效');
    store.setInvite(host.id, room.id, true);

    expect(store.rooms.get(room.id)?.inviteCode).not.toBe(oldCode);
    expect(() => store.joinByCode(guest.id, oldCode)).toThrow('邀请码无效');
    expect(() => store.joinByCode(guest.id, store.rooms.get(room.id)!.inviteCode)).not.toThrow();
  });

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
    completePreparation(table);

    table.takeAction(table.snapshot(host.id).hand!.currentPlayerId!, { type: 'fold' });
    store.maybeFinalize(room.id);
    const currentStacks = new Map(table.players.map((player) => [player.id, player.stack]));
    const members = store.roomView(room.id, host.id).members;

    expect(members.map((member) => [member.id, member.chips])).toEqual(
      expect.arrayContaining([...currentStacks])
    );
    expect(members.some((member) => member.chips !== 500)).toBe(true);
    const settlementEntries = store.ledgerFor(room.id, host.id).filter((entry) => entry.reason === 'hand-settlement');
    expect(settlementEntries).toHaveLength(2);
    expect(settlementEntries.reduce((sum, entry) => sum + entry.amount, 0)).toBe(0);
    store.maybeFinalize(room.id);
    expect(store.ledgerFor(room.id, host.id).filter((entry) => entry.reason === 'hand-settlement')).toHaveLength(2);
  });

  it('finalizes ledger entries when blind all-ins settle during the final shuffle contribution', () => {
    const store = new RiverStore();
    const host = store.createGuest('Host').player;
    const guest = store.createGuest('Guest').player;
    const room = store.createRoom(host.id, { name: 'Blind all-in', maxSeats: 6, smallBlind: 10, initialChips: 20 });
    store.joinByCode(guest.id, room.inviteCode);
    store.credit(host.id, room.id, guest.id, 10, 'blind-all-in-guest');
    const table = store.tableFor(room.id, host.id);
    store.tableFor(room.id, guest.id);
    table.players.find((player) => player.id === host.id)!.stack = 10;
    store.startTable(host.id, room.id);

    completePreparation(table);
    expect(table.snapshot(host.id).hand?.status).toBe('settled');
    store.maybeFinalize(room.id);

    const settlements = store.ledgerFor(room.id, host.id).filter((entry) => entry.reason === 'hand-settlement');
    expect(settlements).toHaveLength(2);
    expect(settlements.reduce((sum, entry) => sum + entry.amount, 0)).toBe(0);
  });

  it('queues credits during an active hand and applies them once at the hand boundary', () => {
    const store = new RiverStore();
    const host = store.createGuest('Host').player;
    const guest = store.createGuest('Guest').player;
    const room = store.createRoom(host.id, { name: 'Boundary credit', maxSeats: 6, smallBlind: 10, initialChips: 500 });
    store.joinByCode(guest.id, room.inviteCode);
    store.credit(host.id, room.id, guest.id, 500, 'initial-guest-credit');
    const table = store.tableFor(room.id, host.id);
    store.tableFor(room.id, guest.id);
    store.startTable(host.id, room.id);
    completePreparation(table);

    const stackDuringHand = table.players.find((player) => player.id === guest.id)!.stack;
    store.credit(host.id, room.id, guest.id, 200, 'queued-credit');
    store.credit(host.id, room.id, guest.id, 200, 'queued-credit');
    expect(table.players.find((player) => player.id === guest.id)!.stack).toBe(stackDuringHand);

    table.takeAction(table.snapshot(host.id).hand!.currentPlayerId!, { type: 'fold' });
    const stackAfterSettlement = table.players.find((player) => player.id === guest.id)!.stack;
    store.maybeFinalize(room.id);

    expect(table.players.find((player) => player.id === guest.id)!.stack).toBe(stackAfterSettlement + 200);
  });

  it('applies host pause and resume commands at a hand boundary', () => {
    const store = new RiverStore();
    const host = store.createGuest('Host').player;
    const guest = store.createGuest('Guest').player;
    const room = store.createRoom(host.id, { name: 'Pause boundary', maxSeats: 6, smallBlind: 10, initialChips: 500 });
    store.joinByCode(guest.id, room.inviteCode);
    store.credit(host.id, room.id, guest.id, 500, 'pause-guest-credit');
    const table = store.tableFor(room.id, host.id);
    store.tableFor(room.id, guest.id);
    store.startTable(host.id, room.id);
    completePreparation(table);

    store.pause(host.id, room.id);
    expect(store.rooms.get(room.id)?.status).toBe('pausing');
    expect(table.snapshot(host.id).hand?.status).toBe('active');

    table.takeAction(table.snapshot(host.id).hand!.currentPlayerId!, { type: 'fold' });
    store.maybeFinalize(room.id);
    expect(store.rooms.get(room.id)?.status).toBe('paused');

    store.resume(host.id, room.id);
    expect(store.rooms.get(room.id)?.status).toBe('active');
  });

  it('removes a member only after the active hand settles', () => {
    const store = new RiverStore();
    const host = store.createGuest('Host').player;
    const guest = store.createGuest('Guest').player;
    const room = store.createRoom(host.id, { name: 'Remove boundary', maxSeats: 6, smallBlind: 10, initialChips: 500 });
    store.joinByCode(guest.id, room.inviteCode);
    store.credit(host.id, room.id, guest.id, 500, 'remove-guest-credit');
    const table = store.tableFor(room.id, host.id);
    store.tableFor(room.id, guest.id);
    store.startTable(host.id, room.id);
    completePreparation(table);

    store.removeMember(host.id, room.id, guest.id);
    expect(store.roomView(room.id, host.id).members.map((member) => member.id)).toContain(guest.id);
    expect(table.players.map((player) => player.id)).toContain(guest.id);

    table.takeAction(table.snapshot(host.id).hand!.currentPlayerId!, { type: 'fold' });
    store.maybeFinalize(room.id);

    expect(store.roomView(room.id, host.id).members.map((member) => member.id)).not.toContain(guest.id);
    expect(table.players.map((player) => player.id)).not.toContain(guest.id);
    expect(store.roomsFor(guest.id)).toEqual([]);
    expect(() => store.roomView(room.id, guest.id)).toThrow('你不是该房间');
    expect(() => store.joinByCode(guest.id, room.inviteCode)).toThrow('已被移除');
  });

  it('finishes an active hand before dissolving and recording final stacks', () => {
    const store = new RiverStore();
    const host = store.createGuest('Host').player;
    const guest = store.createGuest('Guest').player;
    const room = store.createRoom(host.id, { name: 'Dissolve boundary', maxSeats: 6, smallBlind: 10, initialChips: 500 });
    store.joinByCode(guest.id, room.inviteCode);
    store.credit(host.id, room.id, guest.id, 500, 'dissolve-guest-credit');
    const table = store.tableFor(room.id, host.id);
    store.tableFor(room.id, guest.id);
    store.startTable(host.id, room.id);
    completePreparation(table);

    store.dissolve(host.id, room.id);
    expect(store.rooms.get(room.id)?.status).toBe('closing');
    expect(store.historyFor(host.id)).toEqual([]);

    table.takeAction(table.snapshot(host.id).hand!.currentPlayerId!, { type: 'fold' });
    store.maybeFinalize(room.id);

    expect(store.rooms.get(room.id)?.status).toBe('dissolved');
    expect(store.historyFor(host.id)).toEqual([
      expect.objectContaining({ roomId: room.id, playerId: host.id, finalChips: expect.any(Number) })
    ]);
  });
});
