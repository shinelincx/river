import { describe, expect, it } from 'vitest';
import { quickBetOptions } from './App';

const legal = (overrides = {}) => ({
  canFold: true,
  canCheck: false,
  canCall: true,
  canRaise: true,
  toCall: 20,
  callAmount: 20,
  minRaiseTo: 20,
  maxRaiseTo: 1_000,
  raiseAllInOnly: false,
  ...overrides
});

const hand = (currentBet: number, potTotal: number) => ({
  id: 'hand-1', number: 1, commitment: 'commitment', board: [], street: 'flop',
  dealerSeat: 1, smallBlindSeat: 2, bigBlindSeat: 3, currentBet, minRaise: 20,
  status: 'active' as const, potTotal, pots: []
});

describe('quickBetOptions', () => {
  it('offers one-third, half, two-thirds, and full-pot targets before anyone bets on the street', () => {
    expect(quickBetOptions(hand(0, 120), legal(), 10)).toEqual([
      { id: 'third', label: '1/3 池', target: 40 },
      { id: 'half', label: '1/2 池', target: 60 },
      { id: 'two-thirds', label: '2/3 池', target: 80 },
      { id: 'pot', label: '满池', target: 120 }
    ]);
  });

  it('offers minimum, 2.5x, pot-sized, and all-in raises after a bet', () => {
    expect(quickBetOptions(hand(100, 350), legal({ minRaiseTo: 150, maxRaiseTo: 500 }), 10)).toEqual([
      { id: 'minimum', label: '最小加注', target: 150 },
      { id: 'two-half', label: '2.5 倍', target: 250 },
      { id: 'pot-raise', label: '底池加注', target: 470 },
      { id: 'all-in', label: '全下', target: 500 }
    ]);
  });

  it('clamps low 10/20 pot fractions to legal ten-point targets and never marks them unavailable', () => {
    const options = quickBetOptions(hand(0, 40), legal({ minRaiseTo: 20 }), 10);

    expect(options).toEqual([
      { id: 'third', label: '最小下注', target: 20 },
      { id: 'two-thirds', label: '2/3 池', target: 30 },
      { id: 'pot', label: '满池', target: 40 },
      { id: 'all-in', label: '全下', target: 1_000 }
    ]);
    expect(options.every((option) => option.target % 10 === 0)).toBe(true);
  });

  it('shows only the all-in shortcut when a short stack cannot make a full raise', () => {
    expect(quickBetOptions(hand(20, 40), legal({ minRaiseTo: 40, maxRaiseTo: 25, raiseAllInOnly: true }), 10)).toEqual([
      { id: 'all-in', label: '全下', target: 25 }
    ]);
  });

  it('uses 2.5, 3, and 4 big blinds before the flop', () => {
    expect(quickBetOptions({ ...hand(20, 30), street: 'preflop' }, legal({ minRaiseTo: 40 }), 10)).toEqual([
      { id: 'two-half-bb', label: '2.5 BB', target: 50 },
      { id: 'three-bb', label: '3 BB', target: 60 },
      { id: 'four-bb', label: '4 BB', target: 80 },
      { id: 'all-in', label: '全下', target: 1_000 }
    ]);
  });
});
