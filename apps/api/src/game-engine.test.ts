import { describe, expect, it } from 'vitest';
import { compareRanks, evaluateSeven, PokerTable } from './game-engine.js';

describe('poker evaluator', () => {
  it('ranks a straight flush above four of a kind', () => {
    const straightFlush = evaluateSeven([{ rank: 14, suit: 'S' }, { rank: 13, suit: 'S' }, { rank: 12, suit: 'S' }, { rank: 11, suit: 'S' }, { rank: 10, suit: 'S' }, { rank: 2, suit: 'H' }, { rank: 3, suit: 'D' }]);
    const quads = evaluateSeven([{ rank: 9, suit: 'S' }, { rank: 9, suit: 'H' }, { rank: 9, suit: 'D' }, { rank: 9, suit: 'C' }, { rank: 2, suit: 'S' }, { rank: 3, suit: 'H' }, { rank: 4, suit: 'D' }]);
    expect(compareRanks(straightFlush, quads)).toBeGreaterThan(0);
  });
});

describe('server-authoritative table', () => {
  it('waits for the host to explicitly start after two funded players sit down', () => {
    const table = new PokerTable('room-start', 10, 20, 6);
    table.addPlayer({ id: 'a', nickname: 'Alpha', stack: 500 });
    table.addPlayer({ id: 'b', nickname: 'Bravo', stack: 500 });

    expect(table.snapshot('a').hand).toBeUndefined();
    table.startNextHand();
    expect(table.snapshot('a').hand?.status).toBe('active');
  });

  it('hides opponents cards and moves to the flop after matched action', () => {
    const table = new PokerTable('room-1', 10, 20, 6);
    table.addPlayer({ id: 'a', nickname: 'Alpha', stack: 500 });
    table.addPlayer({ id: 'b', nickname: 'Bravo', stack: 500 });
    table.startNextHand();
    const before = table.snapshot('a');
    expect(before.players.find((player) => player.id === 'a')?.hole).toHaveLength(2);
    expect(before.players.find((player) => player.id === 'b')?.hole).toBeUndefined();
    expect(before.hand?.commitment).toMatch(/^[a-f0-9]{64}$/);
    const actor = before.hand?.currentPlayerId!;
    table.takeAction(actor, { type: 'call' });
    const next = table.snapshot('a').hand?.currentPlayerId!;
    table.takeAction(next, { type: 'check' });
    expect(table.snapshot('a').hand?.street).toBe('flop');
    expect(table.snapshot('a').hand?.board).toHaveLength(3);
  });

  it('uses the button as small blind and preserves heads-up action order', () => {
    const table = new PokerTable('room-heads-up-order', 10, 20, 6);
    table.addPlayer({ id: 'a', nickname: 'Alpha', stack: 500 });
    table.addPlayer({ id: 'b', nickname: 'Bravo', stack: 500 });
    table.startNextHand();

    expect(table.snapshot('a').hand).toMatchObject({
      dealerSeat: 1,
      smallBlindSeat: 1,
      bigBlindSeat: 2,
      currentPlayerId: 'a'
    });

    table.takeAction('a', { type: 'call' });
    table.takeAction('b', { type: 'check' });

    expect(table.snapshot('a').hand).toMatchObject({ street: 'flop', currentPlayerId: 'b' });
  });

  it('uses the previous full raise increment when calculating the next minimum raise', () => {
    const table = new PokerTable('room-min-raise-increment', 10, 20, 6);
    table.addPlayer({ id: 'a', nickname: 'Alpha', stack: 500 });
    table.addPlayer({ id: 'b', nickname: 'Bravo', stack: 500 });
    table.startNextHand();

    table.takeAction('a', { type: 'raise', amount: 80 });

    expect(table.snapshot('b').hand?.legalActions).toMatchObject({
      minRaiseTo: 140,
      maxRaiseTo: 500
    });
  });

  it('rejects out-of-turn and undersized raises', () => {
    const table = new PokerTable('room-2', 10, 20, 6);
    table.addPlayer({ id: 'a', nickname: 'Alpha', stack: 500 });
    table.addPlayer({ id: 'b', nickname: 'Bravo', stack: 500 });
    table.startNextHand();
    const actor = table.snapshot('a').hand?.currentPlayerId!;
    expect(() => table.takeAction(actor === 'a' ? 'b' : 'a', { type: 'check' })).toThrow('尚未轮到');
    expect(() => table.takeAction(actor, { type: 'raise', amount: 25 })).toThrow('加注额不足');
  });

  it('keeps the full pot total after current-street bets are swept', () => {
    const table = new PokerTable('room-pot-total', 10, 20, 6);
    table.addPlayer({ id: 'a', nickname: 'Alpha', stack: 500 });
    table.addPlayer({ id: 'b', nickname: 'Bravo', stack: 500 });
    table.startNextHand();

    const first = table.snapshot('a').hand?.currentPlayerId!;
    table.takeAction(first, { type: 'call' });
    const second = table.snapshot('a').hand?.currentPlayerId!;
    table.takeAction(second, { type: 'check' });

    expect(table.snapshot('a').hand).toMatchObject({ street: 'flop', potTotal: 40 });
  });

  it('does not run out or reveal the board when every opponent folds', () => {
    const table = new PokerTable('room-fold-settlement', 10, 20, 6);
    table.addPlayer({ id: 'a', nickname: 'Alpha', stack: 500 });
    table.addPlayer({ id: 'b', nickname: 'Bravo', stack: 500 });
    table.startNextHand();

    const actor = table.snapshot('a').hand?.currentPlayerId!;
    table.takeAction(actor, { type: 'fold' });

    expect(table.snapshot('a').hand).toMatchObject({ status: 'settled', street: 'showdown', board: [] });
  });

  it('does not reopen raising for a player who already acted after a short all-in raise', () => {
    const table = new PokerTable('room-short-all-in', 10, 20, 6);
    table.addPlayer({ id: 'a', nickname: 'Alpha', stack: 500 });
    table.addPlayer({ id: 'b', nickname: 'Bravo', stack: 25 });
    table.addPlayer({ id: 'c', nickname: 'Charlie', stack: 500 });
    table.startNextHand();

    table.takeAction('a', { type: 'call' });
    table.takeAction('b', { type: 'raise', amount: 25 });
    table.takeAction('c', { type: 'call' });

    expect(table.snapshot('a').hand?.currentPlayerId).toBe('a');
    expect(() => table.takeAction('a', { type: 'raise', amount: 45 })).toThrow('本轮行动未重新开放加注');
  });

  it('reopens raising after cumulative short all-ins reach a full raise increment', () => {
    const table = new PokerTable('room-cumulative-all-ins', 10, 20, 6);
    table.addPlayer({ id: 'a', nickname: 'Alpha', stack: 500 });
    table.addPlayer({ id: 'b', nickname: 'Bravo', stack: 25 });
    table.addPlayer({ id: 'c', nickname: 'Charlie', stack: 40 });
    table.addPlayer({ id: 'd', nickname: 'Delta', stack: 500 });
    table.startNextHand();

    table.takeAction('d', { type: 'call' });
    table.takeAction('a', { type: 'call' });
    table.takeAction('b', { type: 'raise', amount: 25 });
    table.takeAction('c', { type: 'raise', amount: 40 });

    expect(table.snapshot('d').hand?.legalActions).toMatchObject({ canRaise: true, minRaiseTo: 60 });
    expect(() => table.takeAction('d', { type: 'raise', amount: 60 })).not.toThrow();
  });

  it('uses the nominal big blind when the big blind player is all-in short', () => {
    const table = new PokerTable('room-short-big-blind', 10, 20, 6);
    table.addPlayer({ id: 'a', nickname: 'Alpha', stack: 500 });
    table.addPlayer({ id: 'b', nickname: 'Bravo', stack: 10 });
    table.startNextHand();

    expect(table.snapshot('a').hand).toMatchObject({ currentBet: 20, legalActions: { toCall: 10, callAmount: 10 } });
    table.takeAction('a', { type: 'call' });
    expect(table.snapshot('a').hand).toMatchObject({ status: 'settled', board: expect.any(Array) });
    expect(table.snapshot('a').hand?.board).toHaveLength(5);
  });

  it('returns an uncalled raise before constructing the final pot', () => {
    const table = new PokerTable('room-uncalled-refund', 10, 20, 6);
    table.addPlayer({ id: 'a', nickname: 'Alpha', stack: 500 });
    table.addPlayer({ id: 'b', nickname: 'Bravo', stack: 500 });
    table.startNextHand();

    table.takeAction('a', { type: 'raise', amount: 100 });
    table.takeAction('b', { type: 'fold' });

    expect(table.snapshot('a').hand).toMatchObject({ potTotal: 40, pots: [{ amount: 40 }] });
    expect(table.players.find((player) => player.id === 'a')?.stack).toBe(520);
    expect(table.recentEvents.at(-1)?.payload.refund).toEqual({ playerId: 'a', amount: 80 });
  });

  it('settles an all-in main pot and side pot without losing chips', () => {
    const table = new PokerTable('room-3', 10, 20, 6);
    table.players.push(
      { id: 'a', nickname: 'Alpha', seat: 1, stack: 50, connected: true, folded: false, allIn: false, bet: 0, contribution: 0, hole: [] },
      { id: 'b', nickname: 'Bravo', seat: 2, stack: 100, connected: true, folded: false, allIn: false, bet: 0, contribution: 0, hole: [] },
      { id: 'c', nickname: 'Charlie', seat: 3, stack: 200, connected: true, folded: false, allIn: false, bet: 0, contribution: 0, hole: [] }
    );
    table.startNextHand();
    table.takeAction('a', { type: 'raise', amount: 50 });
    table.takeAction('b', { type: 'call' });
    table.takeAction('c', { type: 'raise', amount: 100 });
    table.takeAction('b', { type: 'call' });
    // Once every opponent is all-in, the remaining board runs out automatically.
    expect(table.snapshot('a').hand?.status).toBe('settled');
    expect(table.snapshot('a').hand).toMatchObject({ potTotal: 250, pots: [{ amount: 150 }, { amount: 100 }] });
    expect(table.players.reduce((sum, player) => sum + player.stack, 0)).toBe(350);
    expect(table.recentEvents.at(-1)?.type).toBe('hand_settled');
  });
});
