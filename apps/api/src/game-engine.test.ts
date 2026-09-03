import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareRanks, deterministicDeck, evaluateSeven, PokerTable, verifyHandAudit, type Card } from './game-engine.js';

afterEach(() => vi.useRealTimers());

function startHand(table: PokerTable, contributions: Record<string, string> = {}): void {
  table.startNextHand();
  const preparing = table.snapshot('system').preparing;
  if (!preparing) return;
  for (const playerId of preparing.participantIds) {
    table.setShuffleContribution(playerId, preparing.id, contributions[playerId] ?? `test-entropy-${playerId.padEnd(16, '0')}`);
  }
}

describe('poker evaluator', () => {
  it('ranks a straight flush above four of a kind', () => {
    const straightFlush = evaluateSeven([{ rank: 14, suit: 'S' }, { rank: 13, suit: 'S' }, { rank: 12, suit: 'S' }, { rank: 11, suit: 'S' }, { rank: 10, suit: 'S' }, { rank: 2, suit: 'H' }, { rank: 3, suit: 'D' }]);
    const quads = evaluateSeven([{ rank: 9, suit: 'S' }, { rank: 9, suit: 'H' }, { rank: 9, suit: 'D' }, { rank: 9, suit: 'C' }, { rank: 2, suit: 'S' }, { rank: 3, suit: 'H' }, { rank: 4, suit: 'D' }]);
    expect(compareRanks(straightFlush, quads)).toBeGreaterThan(0);
  });
});

describe('server-authoritative table', () => {
  it('commits the server seed before collecting hand-bound player contributions', () => {
    const table = new PokerTable('room-commit-first', 10, 20, 6);
    table.addPlayer({ id: 'a', nickname: 'Alpha', stack: 500 });
    table.addPlayer({ id: 'b', nickname: 'Bravo', stack: 500 });

    table.startNextHand();
    const preparing = table.snapshot('a').preparing;

    expect(table.snapshot('a').hand).toBeUndefined();
    expect(preparing).toMatchObject({ commitment: expect.stringMatching(/^[a-f0-9]{64}$/), readyPlayerIds: [] });
    table.setShuffleContribution('a', preparing!.id, 'alpha-device-entropy-0001');
    expect(table.snapshot('a').hand).toBeUndefined();
    expect(() => table.setShuffleContribution('a', preparing!.id, 'replacement-entropy-0001')).toThrow('已提交');
    table.setShuffleContribution('b', preparing!.id, 'bravo-device-entropy-0001');

    expect(table.snapshot('a').preparing).toBeUndefined();
    expect(table.snapshot('a').hand?.status).toBe('active');
  });

  it('waits for the host to explicitly start after two funded players sit down', () => {
    const table = new PokerTable('room-start', 10, 20, 6);
    table.addPlayer({ id: 'a', nickname: 'Alpha', stack: 500 });
    table.addPlayer({ id: 'b', nickname: 'Bravo', stack: 500 });

    expect(table.snapshot('a').hand).toBeUndefined();
    startHand(table);
    expect(table.snapshot('a').hand?.status).toBe('active');
  });

  it('publishes the exact professional action for table announcements', () => {
    const table = new PokerTable('room-action-announcement', 10, 20, 6);
    table.addPlayer({ id: 'a', nickname: 'Alpha', stack: 500 });
    table.addPlayer({ id: 'b', nickname: 'Bravo', stack: 500 });
    startHand(table);

    const preflopActor = table.snapshot('a').hand!.currentPlayerId!;
    table.takeAction(preflopActor, { type: 'call' });

    expect(table.snapshot('a').hand?.lastAction).toMatchObject({ playerId: preflopActor, type: 'call' });
    const blindPlayer = table.snapshot('a').hand!.currentPlayerId!;
    table.takeAction(blindPlayer, { type: 'check' });
    const flopActor = table.snapshot('a').hand!.currentPlayerId!;
    table.takeAction(flopActor, { type: 'raise', amount: 20 });

    expect(table.snapshot('a').hand?.lastAction).toMatchObject({ playerId: flopActor, type: 'bet' });

    const allInTable = new PokerTable('room-all-in-announcement', 10, 20, 6);
    allInTable.addPlayer({ id: 'a', nickname: 'Alpha', stack: 500 });
    allInTable.addPlayer({ id: 'b', nickname: 'Bravo', stack: 500 });
    startHand(allInTable);
    const allInActor = allInTable.snapshot('a').hand!.currentPlayerId!;
    const maxRaiseTo = allInTable.snapshot(allInActor).hand!.legalActions!.maxRaiseTo;
    allInTable.takeAction(allInActor, { type: 'raise', amount: maxRaiseTo });

    expect(allInTable.snapshot('a').hand?.lastAction).toMatchObject({ playerId: allInActor, type: 'allIn' });
  });

  it('keeps a player who joins mid-hand waiting until the next hand boundary', () => {
    const table = new PokerTable('room-waiting-seat', 10, 20, 6);
    table.addPlayer({ id: 'a', nickname: 'Alpha', stack: 500 });
    table.addPlayer({ id: 'b', nickname: 'Bravo', stack: 500 });
    startHand(table);

    table.addPlayer({ id: 'c', nickname: 'Charlie', stack: 500 });

    expect(table.snapshot('c').players.find((player) => player.id === 'c')).toMatchObject({
      participation: 'waiting',
      hole: undefined
    });

    table.takeAction(table.snapshot('a').hand!.currentPlayerId!, { type: 'fold' });
    startHand(table);

    expect(table.snapshot('c').players.find((player) => player.id === 'c')).toMatchObject({
      participation: 'seated',
      hole: expect.any(Array)
    });
    expect(table.snapshot('c').players.find((player) => player.id === 'c')?.hole).toHaveLength(2);
  });

  it('reveals a verifiable shuffle audit only to participants for 10 days after settlement', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T12:00:00Z'));
    const table = new PokerTable('room-audit', 10, 20, 6);
    table.addPlayer({ id: 'a', nickname: 'Alpha', stack: 500 });
    table.addPlayer({ id: 'b', nickname: 'Bravo', stack: 500 });
    startHand(table, { a: 'alpha-device-entropy-0001', b: 'bravo-device-entropy-0001' });
    const handId = table.snapshot('a').hand!.id;
    table.addPlayer({ id: 'c', nickname: 'Charlie', stack: 500 });

    expect(() => table.auditFor(handId, 'a')).toThrow('尚未结算');
    table.takeAction(table.snapshot('a').hand!.currentPlayerId!, { type: 'fold' });

    const audit = table.auditFor(handId, 'a');
    expect(audit.participantIds).toEqual(expect.arrayContaining(['a', 'b']));
    expect(audit.participantIds).not.toContain('c');
    expect(audit.playerContributions).toEqual({
      a: 'alpha-device-entropy-0001',
      b: 'bravo-device-entropy-0001'
    });
    expect(await verifyHandAudit(audit)).toBe(true);
    const tamperedHoleCards = structuredClone(audit);
    tamperedHoleCards.holeCards.a = [...tamperedHoleCards.holeCards.b];
    expect(await verifyHandAudit(tamperedHoleCards)).toBe(false);
    const tamperedPayout = structuredClone(audit);
    tamperedPayout.result.payouts.a = (tamperedPayout.result.payouts.a ?? 0) + 1;
    expect(await verifyHandAudit(tamperedPayout)).toBe(false);
    const falsifiedFold = structuredClone(audit);
    falsifiedFold.foldedPlayerIds = audit.participantIds.filter((id) => !audit.foldedPlayerIds.includes(id)).slice(0, 1);
    expect(await verifyHandAudit(falsifiedFold)).toBe(false);
    const falsifiedSettlement = structuredClone(audit);
    falsifiedSettlement.events.find((event) => event.type === 'hand_settled')!.payload.settledBy = 'showdown';
    expect(await verifyHandAudit(falsifiedSettlement)).toBe(false);
    const rewrittenCommitment = structuredClone(audit);
    rewrittenCommitment.serverSeed = 'f'.repeat(64);
    rewrittenCommitment.commitment = createHash('sha256').update(`${rewrittenCommitment.algorithmVersion}:${rewrittenCommitment.serverSeed}`).digest('hex');
    rewrittenCommitment.deck = deterministicDeck(rewrittenCommitment.serverSeed, rewrittenCommitment.playerContributions, rewrittenCommitment.handId);
    const rewrittenDeck = structuredClone(rewrittenCommitment.deck);
    for (const playerId of rewrittenCommitment.dealOrder) rewrittenCommitment.holeCards[playerId] = [rewrittenDeck.pop()!, rewrittenDeck.pop()!];
    rewrittenCommitment.board = Array.from({ length: rewrittenCommitment.board.length }, () => rewrittenDeck.pop()!);
    expect(await verifyHandAudit(rewrittenCommitment)).toBe(false);
    for (const event of rewrittenCommitment.events.filter((item) => ['shuffle_committed', 'hand_started', 'hand_settled'].includes(item.type))) {
      event.payload.commitment = rewrittenCommitment.commitment;
    }
    expect(await verifyHandAudit(rewrittenCommitment, audit.commitment)).toBe(false);
    const replay = table.replayFor(handId, 'a');
    expect(replay.blinds).toEqual({ small: 10, big: 20 });
    expect(replay.players.find((player) => player.id === 'a')).toMatchObject({ nickname: 'Alpha', pointDelta: expect.any(Number) });
    expect(replay.players.find((player) => player.id === 'a')?.hole).toHaveLength(2);
    expect(replay.players.find((player) => player.id === 'b')?.hole).toBeUndefined();
    expect(JSON.stringify(replay)).not.toContain(audit.serverSeed);
    expect(table.handHistoryFor('a')[0]).toMatchObject({ handId, handNumber: 1, pointDeltas: expect.any(Object) });
    expect(() => table.auditFor(handId, 'c')).toThrow('仅本手参与者');
    expect(JSON.stringify(table.recentEvents)).not.toContain(audit.serverSeed);

    vi.setSystemTime(new Date('2026-09-07T12:00:00.001Z'));
    expect(() => table.auditFor(handId, 'a')).toThrow('已过期');
  });

  it('limits a removed player hand-history listing to hands they participated in', () => {
    const table = new PokerTable('room-former-player-history', 10, 20, 6);
    table.addPlayer({ id: 'a', nickname: 'Alpha', stack: 500 });
    table.addPlayer({ id: 'b', nickname: 'Bravo', stack: 500 });
    startHand(table);
    const firstHandId = table.snapshot('a').hand!.id;
    table.takeAction(table.snapshot('a').hand!.currentPlayerId!, { type: 'fold' });
    table.removePlayer('b');
    table.addPlayer({ id: 'c', nickname: 'Charlie', stack: 500 });
    startHand(table);
    const secondHandId = table.snapshot('a').hand!.id;
    table.takeAction(table.snapshot('a').hand!.currentPlayerId!, { type: 'fold' });

    expect(table.handHistoryFor('b').map((hand) => hand.handId)).toEqual([firstHandId]);
    expect(() => table.replayFor(secondHandId, 'b')).toThrow('无权读取');
  });

  it('hides opponents cards and moves to the flop after matched action', () => {
    const table = new PokerTable('room-1', 10, 20, 6);
    table.addPlayer({ id: 'a', nickname: 'Alpha', stack: 500 });
    table.addPlayer({ id: 'b', nickname: 'Bravo', stack: 500 });
    startHand(table);
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

  it('restores an active table with the exact deck, actor, bets, events and idempotency state', () => {
    const table = new PokerTable('room-restore', 10, 20, 6);
    table.addPlayer({ id: 'a', nickname: 'Alpha', stack: 500 });
    table.addPlayer({ id: 'b', nickname: 'Bravo', stack: 500 });
    startHand(table);
    const beforeAction = table.snapshot('a');
    const command = {
      actionId: 'persisted-action',
      handId: beforeAction.hand!.id,
      version: beforeAction.sequence,
      type: 'call'
    };
    table.submitAction(beforeAction.hand!.currentPlayerId!, command);

    const restored = PokerTable.fromState(table.exportState());

    expect(restored.snapshot('a')).toEqual(table.snapshot('a'));
    expect(restored.recentEvents).toEqual(table.recentEvents);
    expect(restored.submitAction(beforeAction.hand!.currentPlayerId!, command)).toEqual({
      accepted: false,
      sequence: table.snapshot('a').sequence
    });
    expect(restored.recentEvents.filter((event) => event.type === 'action')).toHaveLength(1);
  });

  it('removes expired audit and replay material from every in-memory storage location', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T12:00:00Z'));
    const table = new PokerTable('room-expiry-scrub', 10, 20, 6);
    table.addPlayer({ id: 'a', nickname: 'Alpha', stack: 500 });
    table.addPlayer({ id: 'b', nickname: 'Bravo', stack: 500 });
    table.startNextHand();
    const preparing = table.snapshot('a').preparing!;
    table.setShuffleContribution('a', preparing.id, 'alpha-device-entropy-0001');
    table.setShuffleContribution('b', preparing.id, 'bravo-device-entropy-0001');
    const handId = table.snapshot('a').hand!.id;
    table.takeAction(table.snapshot('a').hand!.currentPlayerId!, { type: 'fold' });
    const secret = table.auditFor(handId, 'a').serverSeed;
    const withoutRetainedAudit = table.exportState();
    withoutRetainedAudit.audits = [];
    expect(PokerTable.fromState(withoutRetainedAudit).players.every((player) => player.hole.length === 0)).toBe(true);

    expect(table.purgeExpiredAudits(Date.parse('2026-09-07T12:00:00.001Z'))).toBe(1);
    expect(() => table.replayFor(handId, 'a')).toThrow('不存在');
    expect(JSON.stringify(table.exportState())).not.toContain(secret);
  });

  it('rejects tampered board, pot and payout fields during full showdown verification', async () => {
    const table = new PokerTable('room-full-verifier', 10, 20, 6);
    table.addPlayer({ id: 'a', nickname: 'Alpha', stack: 500 });
    table.addPlayer({ id: 'b', nickname: 'Bravo', stack: 500 });
    startHand(table);
    const handId = table.snapshot('a').hand!.id;
    table.takeAction('a', { type: 'raise', amount: 500 });
    table.takeAction('b', { type: 'call' });
    const audit = table.auditFor(handId, 'a');

    expect(await verifyHandAudit(audit)).toBe(true);
    const board = structuredClone(audit);
    board.board[0].rank = board.board[0].rank === 14 ? 13 : board.board[0].rank + 1;
    expect(await verifyHandAudit(board)).toBe(false);
    const pots = structuredClone(audit);
    pots.result.pots[0].amount += 1;
    expect(await verifyHandAudit(pots)).toBe(false);
    const payouts = structuredClone(audit);
    const winner = Object.keys(payouts.result.payouts)[0];
    payouts.result.payouts[winner] += 1;
    expect(await verifyHandAudit(payouts)).toBe(false);
  });

  it('keeps overflow players off physical seats until a hand boundary frees one', () => {
    const table = new PokerTable('room-seat-queue', 10, 20, 6);
    for (let index = 1; index <= 7; index++) table.addPlayer({ id: `p${index}`, nickname: `P${index}`, stack: 500 });

    expect(table.players.find((player) => player.id === 'p7')).toMatchObject({ seat: 0, participation: 'waiting' });
    table.removePlayer('p1');
    startHand(table);

    expect(table.players.find((player) => player.id === 'p7')).toMatchObject({ seat: 1, participation: 'seated' });
    expect(new Set(table.players.filter((player) => player.seat > 0).map((player) => player.seat)).size).toBe(6);
  });

  it('uses the button as small blind and preserves heads-up action order', () => {
    const table = new PokerTable('room-heads-up-order', 10, 20, 6);
    table.addPlayer({ id: 'a', nickname: 'Alpha', stack: 500 });
    table.addPlayer({ id: 'b', nickname: 'Bravo', stack: 500 });
    startHand(table);

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
    startHand(table);

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
    startHand(table);
    const actor = table.snapshot('a').hand?.currentPlayerId!;
    expect(() => table.takeAction(actor === 'a' ? 'b' : 'a', { type: 'check' })).toThrow('尚未轮到');
    expect(() => table.takeAction(actor, { type: 'raise', amount: 25 })).toThrow('加注额不足');
  });

  it('requires normal raises to use the small-blind denomination but permits an odd short all-in', () => {
    const table = new PokerTable('room-chip-unit', 10, 20, 6);
    table.addPlayer({ id: 'a', nickname: 'Alpha', stack: 500 });
    table.addPlayer({ id: 'b', nickname: 'Bravo', stack: 500 });
    startHand(table);

    const actor = table.snapshot('a').hand!.currentPlayerId!;
    expect(() => table.takeAction(actor, { type: 'raise', amount: 45 })).toThrow('下注必须是小盲的整数倍');
    expect(() => table.takeAction(actor, { type: 'raise', amount: 40 })).not.toThrow();

    const shortStack = new PokerTable('room-odd-all-in', 10, 20, 6);
    shortStack.addPlayer({ id: 'a', nickname: 'Alpha', stack: 45 });
    shortStack.addPlayer({ id: 'b', nickname: 'Bravo', stack: 500 });
    startHand(shortStack);
    expect(() => shortStack.takeAction('a', { type: 'raise', amount: 45 })).not.toThrow();
  });

  it('keeps the full pot total after current-street bets are swept', () => {
    const table = new PokerTable('room-pot-total', 10, 20, 6);
    table.addPlayer({ id: 'a', nickname: 'Alpha', stack: 500 });
    table.addPlayer({ id: 'b', nickname: 'Bravo', stack: 500 });
    startHand(table);

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
    startHand(table);

    const actor = table.snapshot('a').hand?.currentPlayerId!;
    table.takeAction(actor, { type: 'fold' });

    expect(table.snapshot('a').hand).toMatchObject({
      status: 'settled', street: 'showdown', board: [], settlement: { settledBy: 'fold', payouts: expect.any(Object) }
    });
  });

  it('does not reopen raising for a player who already acted after a short all-in raise', () => {
    const table = new PokerTable('room-short-all-in', 10, 20, 6);
    table.addPlayer({ id: 'a', nickname: 'Alpha', stack: 500 });
    table.addPlayer({ id: 'b', nickname: 'Bravo', stack: 25 });
    table.addPlayer({ id: 'c', nickname: 'Charlie', stack: 500 });
    startHand(table);

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
    startHand(table);

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
    startHand(table);

    expect(table.snapshot('a').hand).toMatchObject({ currentBet: 20, legalActions: { toCall: 10, callAmount: 10 } });
    table.takeAction('a', { type: 'call' });
    const settled = table.snapshot('a');
    expect(settled.hand).toMatchObject({ status: 'settled', board: expect.any(Array), settlement: { settledBy: 'showdown', payouts: expect.any(Object) } });
    expect(settled.hand?.board).toHaveLength(5);
    expect(settled.players.find((player) => player.id === 'b')?.hole).toHaveLength(2);
  });

  it('returns an uncalled raise before constructing the final pot', () => {
    const table = new PokerTable('room-uncalled-refund', 10, 20, 6);
    table.addPlayer({ id: 'a', nickname: 'Alpha', stack: 500 });
    table.addPlayer({ id: 'b', nickname: 'Bravo', stack: 500 });
    startHand(table);

    table.takeAction('a', { type: 'raise', amount: 100 });
    table.takeAction('b', { type: 'fold' });

    expect(table.snapshot('a').hand).toMatchObject({ potTotal: 40, pots: [{ amount: 40 }] });
    expect(table.players.find((player) => player.id === 'a')?.stack).toBe(520);
    expect(table.recentEvents.at(-1)?.payload.refund).toEqual({ playerId: 'a', amount: 80 });
  });

  it('settles an all-in main pot and side pot without losing chips', () => {
    const table = new PokerTable('room-3', 10, 20, 6);
    table.players.push(
      { id: 'a', nickname: 'Alpha', seat: 1, stack: 50, connected: true, participation: 'seated', folded: false, allIn: false, bet: 0, contribution: 0, hole: [] },
      { id: 'b', nickname: 'Bravo', seat: 2, stack: 100, connected: true, participation: 'seated', folded: false, allIn: false, bet: 0, contribution: 0, hole: [] },
      { id: 'c', nickname: 'Charlie', seat: 3, stack: 200, connected: true, participation: 'seated', folded: false, allIn: false, bet: 0, contribution: 0, hole: [] }
    );
    startHand(table);
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

  it('uses six-player physical order and skips folded or all-in players after the flop', () => {
    const table = new PokerTable('room-six-player-order', 10, 20, 6);
    for (const [index, id] of ['a', 'b', 'c', 'd', 'e', 'f'].entries()) {
      table.addPlayer({ id, nickname: id.toUpperCase(), stack: id === 'e' ? 20 : 500 });
    }
    startHand(table);

    expect(table.snapshot('a').hand).toMatchObject({
      dealerSeat: 1,
      smallBlindSeat: 2,
      bigBlindSeat: 3,
      currentPlayerId: 'd'
    });
    table.takeAction('d', { type: 'fold' });
    table.takeAction('e', { type: 'call' });
    expect(table.players.find((player) => player.id === 'e')).toMatchObject({ allIn: true });
    table.takeAction('f', { type: 'call' });
    table.takeAction('a', { type: 'call' });
    table.takeAction('b', { type: 'call' });
    table.takeAction('c', { type: 'check' });

    expect(table.snapshot('a').hand).toMatchObject({ street: 'flop', currentPlayerId: 'b' });
    table.takeAction('b', { type: 'check' });
    table.takeAction('c', { type: 'check' });
    expect(table.snapshot('a').hand?.currentPlayerId).toBe('f');
  });

  it('accepts a short opening all-in after the flop without treating it as a full raise', () => {
    const table = new PokerTable('room-flop-short-opening', 10, 20, 6);
    table.addPlayer({ id: 'a', nickname: 'Alpha', stack: 500 });
    table.addPlayer({ id: 'b', nickname: 'Bravo', stack: 25 });
    table.addPlayer({ id: 'c', nickname: 'Charlie', stack: 500 });
    startHand(table);
    table.takeAction('a', { type: 'call' });
    table.takeAction('b', { type: 'call' });
    table.takeAction('c', { type: 'check' });

    expect(table.snapshot('b').hand).toMatchObject({ street: 'flop', currentPlayerId: 'b' });
    table.takeAction('b', { type: 'raise', amount: 5 });

    expect(table.snapshot('c').hand).toMatchObject({
      currentBet: 5,
      minRaise: 20,
      legalActions: { toCall: 5, minRaiseTo: 25 }
    });
  });

  it('builds exact multi-level side pots including folded dead money', () => {
    const table = new PokerTable('room-multi-side-pot', 10, 20, 6);
    for (const id of ['a', 'b', 'c', 'd']) table.addPlayer({ id, nickname: id.toUpperCase(), stack: 500 });
    startHand(table);
    const state = table.exportState();
    const holes: Record<string, Card[]> = {
      a: [{ rank: 14, suit: 'S' }, { rank: 14, suit: 'H' }],
      b: [{ rank: 13, suit: 'S' }, { rank: 13, suit: 'H' }],
      c: [{ rank: 12, suit: 'S' }, { rank: 12, suit: 'H' }],
      d: [{ rank: 4, suit: 'S' }, { rank: 5, suit: 'H' }]
    };
    const contributions = { a: 50, b: 100, c: 150, d: 150 } as const;
    for (const player of state.players) {
      player.hole = structuredClone(holes[player.id]);
      player.contribution = contributions[player.id as keyof typeof contributions];
      player.stack = 0;
      player.bet = 0;
      player.allIn = player.id !== 'a';
      player.folded = player.id === 'd';
    }
    Object.assign(state.hand!, {
      board: [{ rank: 2, suit: 'S' }, { rank: 3, suit: 'H' }, { rank: 7, suit: 'D' }, { rank: 9, suit: 'C' }, { rank: 11, suit: 'C' }],
      street: 'river',
      currentPlayerId: 'a',
      currentBet: 0,
      pending: ['a'],
      actedAtBet: []
    });
    const restored = PokerTable.fromState(state);

    restored.takeAction('a', { type: 'check' });

    expect(restored.snapshot('a').hand?.pots).toEqual([
      { amount: 200, eligiblePlayerIds: ['a', 'b', 'c'] },
      { amount: 150, eligiblePlayerIds: ['b', 'c'] },
      { amount: 100, eligiblePlayerIds: ['c'] }
    ]);
    expect(restored.auditFor(state.hand!.id, 'a').result.payouts).toEqual({ a: 200, b: 150, c: 100 });
    expect(restored.players.reduce((total, player) => total + player.stack, 0)).toBe(450);
  });

  it('awards an odd chip clockwise left of the physical button and keeps folded dead money', () => {
    const table = new PokerTable('room-odd-chip', 1, 2, 6);
    for (const id of ['a', 'b', 'c']) table.addPlayer({ id, nickname: id.toUpperCase(), stack: 10 });
    startHand(table);
    const state = table.exportState();
    for (const player of state.players) {
      player.hole = [{ rank: player.seat + 2, suit: 'H' }, { rank: player.seat + 5, suit: 'D' }];
      player.contribution = 1;
      player.stack = 9;
      player.bet = 0;
      player.allIn = false;
      player.folded = player.id === 'c';
    }
    Object.assign(state.hand!, {
      board: [{ rank: 14, suit: 'S' }, { rank: 13, suit: 'S' }, { rank: 12, suit: 'S' }, { rank: 11, suit: 'S' }, { rank: 10, suit: 'S' }],
      street: 'river',
      currentPlayerId: 'a',
      currentBet: 0,
      pending: ['a'],
      actedAtBet: []
    });
    const restored = PokerTable.fromState(state);

    restored.takeAction('a', { type: 'check' });

    expect(restored.auditFor(state.hand!.id, 'a').result).toMatchObject({
      pots: [{ amount: 3, eligiblePlayerIds: ['a', 'b'] }],
      payouts: { a: 1, b: 2 }
    });
    expect(restored.players.reduce((total, player) => total + player.stack, 0)).toBe(30);
  });

  it('preserves total chips across deterministic randomized legal action sequences', () => {
    let randomState = 0x51f15e;
    const nextRandom = () => (randomState = (randomState * 1664525 + 1013904223) >>> 0);
    for (let run = 0; run < 25; run++) {
      const table = new PokerTable(`room-random-${run}`, 5, 10, 6);
      const stacks = Array.from({ length: 4 }, () => 40 + nextRandom() % 161);
      stacks.forEach((stack, index) => table.addPlayer({ id: `p${index}`, nickname: `P${index}`, stack }));
      const initialTotal = stacks.reduce((total, stack) => total + stack, 0);
      startHand(table);
      for (let step = 0; step < 200 && table.snapshot('p0').hand?.status === 'active'; step++) {
        const snapshot = table.snapshot('p0');
        const actor = snapshot.hand!.currentPlayerId!;
        const legal = table.snapshot(actor).hand!.legalActions!;
        const actions: Array<{ type: 'fold' | 'check' | 'call' | 'raise'; amount?: number }> = [];
        if (legal.canFold) actions.push({ type: 'fold' });
        if (legal.canCheck) actions.push({ type: 'check' });
        if (legal.canCall) actions.push({ type: 'call' });
        if (legal.canRaise) actions.push({ type: 'raise', amount: legal.raiseAllInOnly ? legal.maxRaiseTo : legal.minRaiseTo });
        table.takeAction(actor, actions[nextRandom() % actions.length]);
        if (table.snapshot('p0').hand?.status === 'active') {
          expect(table.players.reduce((total, player) => total + player.stack + player.contribution, 0)).toBe(initialTotal);
        }
      }
      expect(table.snapshot('p0').hand?.status).toBe('settled');
      expect(table.players.reduce((total, player) => total + player.stack, 0)).toBe(initialTotal);
    }
  });
});
