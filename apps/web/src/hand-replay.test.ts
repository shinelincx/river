import { describe, expect, it } from 'vitest';
import type { HandReplay } from './api';
import { buildReplayStages, describeReplayMoment } from './hand-replay';

const replay: HandReplay = {
  handId: 'hand-1',
  handNumber: 15,
  blinds: { small: 20, big: 40 },
  board: [{ rank: 12, suit: 'H' }, { rank: 4, suit: 'D' }, { rank: 8, suit: 'S' }],
  players: [
    { id: 'p1', nickname: '深海玩家', pointDelta: 80 },
    { id: 'p2', nickname: '潮汐玩家', pointDelta: -80 }
  ],
  events: [
    { sequence: 1, type: 'shuffle_committed', payload: { commitment: 'technical-data' } },
    { sequence: 2, type: 'blinds_posted', payload: { smallBlindPlayerId: 'p1', smallBlindAmount: 20, bigBlindPlayerId: 'p2', bigBlindAmount: 40 } },
    { sequence: 3, type: 'action', payload: { playerId: 'p1', type: 'call', street: 'preflop', committedAmount: 20, contributionAfter: 40, stackAfter: 1460, source: 'player' } },
    { sequence: 4, type: 'street_started', payload: { street: 'flop' } },
    { sequence: 5, type: 'action', payload: { playerId: 'p2', type: 'raise', street: 'flop', amount: 80, committedAmount: 80, contributionAfter: 120, betAfter: 80, stackAfter: 1380, source: 'player' } },
    { sequence: 6, type: 'action', payload: { playerId: 'p1', type: 'fold', street: 'flop', committedAmount: 0, contributionAfter: 40, stackAfter: 1460, source: 'timeout' } },
    { sequence: 7, type: 'payout_awarded', payload: { playerId: 'p2', amount: 160 } }
  ],
  result: { pots: [{ amount: 160, eligiblePlayerIds: ['p2'] }], payouts: { p2: 160 }, settledBy: 'fold' },
  settledAt: '2026-08-30T07:00:00.000Z',
  expiresAt: '2026-09-09T07:00:00.000Z'
};

describe('hand replay presentation', () => {
  it('groups player-facing moments by poker street and omits technical events', () => {
    const stages = buildReplayStages(replay);
    expect(stages.map((stage) => stage.id)).toEqual(['preflop', 'flop', 'result']);
    expect(stages.flatMap((stage) => stage.moments.map((moment) => moment.sequence))).toEqual([2, 3, 5, 6, 7]);
    expect(stages[1].board).toEqual(replay.board);
  });

  it('turns raw actions into concise Chinese poker language', () => {
    const flop = buildReplayStages(replay).find((stage) => stage.id === 'flop');
    const name = (id?: string) => replay.players.find((player) => player.id === id)?.nickname ?? '未知玩家';
    const amount = (value: number) => String(value);
    expect(describeReplayMoment(flop!.moments[0], name, amount)).toMatchObject({ title: '潮汐玩家 下注 80' });
    expect(describeReplayMoment(flop!.moments[1], name, amount)).toMatchObject({ title: '深海玩家 弃牌', detail: '超时自动 · 本手累计 40 · 剩余 1460' });
  });
});
