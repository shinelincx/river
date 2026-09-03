import { describe, expect, it } from 'vitest';
import { tableSoundEvents, type SoundSnapshot } from './table-sound-events';

const player = (id: string, allIn = false) => ({ id, allIn });
const snapshot = (input: Partial<SoundSnapshot> = {}): SoundSnapshot => ({
  sequence: 1,
  players: [player('host'), player('guest')],
  hand: { number: 1, status: 'active', board: [], currentPlayerId: 'host' },
  ...input
});

describe('table sound events', () => {
  it('does not announce all-in again when the same snapshot settles the hand', () => {
    const previous = snapshot();
    const settled = snapshot({
      sequence: 2,
      players: [player('host', true), player('guest', true)],
      hand: { number: 1, status: 'settled', board: [], currentPlayerId: undefined }
    });

    expect(tableSoundEvents(previous, settled, 'host')).toEqual(['settle']);
  });

  it('announces a terminal action before the resulting settlement', () => {
    const previous = snapshot();
    const settledAfterFold = snapshot({
      sequence: 2,
      hand: { number: 1, status: 'settled', board: [], currentPlayerId: undefined, lastAction: { sequence: 2, playerId: 'host', type: 'fold' } }
    });

    expect(tableSoundEvents(previous, settledAfterFold, 'host')).toEqual(['fold', 'settle']);
  });

  it('announces a newly all-in player while the hand remains active', () => {
    const previous = snapshot();
    const allInAction = snapshot({
      sequence: 2,
      players: [player('host', true), player('guest')],
      hand: { number: 1, status: 'active', board: [], currentPlayerId: 'host', lastAction: { sequence: 2, playerId: 'host', type: 'allIn' } }
    });

    expect(tableSoundEvents(previous, allInAction, 'guest')).toEqual(['allIn']);
  });

  it.each(['fold', 'check', 'call', 'bet', 'raise'] as const)('announces the exact poker action: %s', (type) => {
    const previous = snapshot();
    const action = snapshot({
      sequence: 2,
      hand: { number: 1, status: 'active', board: [], currentPlayerId: 'host', lastAction: { sequence: 2, playerId: 'host', type } }
    });

    expect(tableSoundEvents(previous, action, 'guest')).toEqual([type]);
  });
});
