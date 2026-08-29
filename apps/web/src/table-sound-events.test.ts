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

  it('announces a newly all-in player while the hand remains active', () => {
    const previous = snapshot();
    const allInAction = snapshot({ sequence: 2, players: [player('host', true), player('guest')] });

    expect(tableSoundEvents(previous, allInAction, 'guest')).toContain('allIn');
  });
});
