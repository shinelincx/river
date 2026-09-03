import { describe, expect, it } from 'vitest';
import { inviteCodeFromInput, inviteCodeFromPath } from './invite-route';
import { canRenderReplayHole, participantStatus, seatBorderState, seatLayout, settlementWinners } from './table-view';

describe('Web requirement acceptance', () => {
  it('parses a valid /join/:inviteCode deep link and rejects unrelated paths', () => {
    expect(inviteCodeFromPath('/join/7KQ3X9MP')).toBe('7KQ3X9MP');
    expect(inviteCodeFromPath('/join/river-Ab_123')).toBe('RIVER-AB_123');
    expect(inviteCodeFromPath('/join/RIVER-ABC/extra')).toBeUndefined();
    expect(inviteCodeFromPath('/rooms/RIVER-ABC')).toBeUndefined();
  });

  it('accepts either a code or a full invite link pasted into the join field', () => {
    expect(inviteCodeFromInput('7kq3x9mp')).toBe('7KQ3X9MP');
    expect(inviteCodeFromInput('https://river.example/join/RIVER-ab_123')).toBe('RIVER-AB_123');
    expect(inviteCodeFromInput('https://river.example/rooms/RIVER-AB_123')).toBeUndefined();
  });

  it.each([6, 9] as const)('keeps physical seats stable while rotating each observer to the bottom on a %i-seat table', (maxSeats) => {
    const players = [{ id: 'player-33', seat: 1 }, { id: 'player-123', seat: 2 }];
    const player33View = seatLayout(maxSeats, players, 'player-33');
    const player123View = seatLayout(maxSeats, players, 'player-123');

    expect(player33View.find((seat) => seat.player?.id === 'player-33')).toMatchObject({ physicalSeat: 1, visualOffset: 0 });
    expect(player123View.find((seat) => seat.player?.id === 'player-33')).toMatchObject({ physicalSeat: 1, visualOffset: maxSeats - 1 });
    expect(player33View.find((seat) => seat.player?.id === 'player-123')).toMatchObject({ physicalSeat: 2, visualOffset: maxSeats === 9 ? 2 : 1 });
    expect(player123View.find((seat) => seat.player?.id === 'player-123')).toMatchObject({ physicalSeat: 2, visualOffset: 0 });
  });

  it('maps the nine-seat action order through the rebuilt visual ring instead of CSS slot numbers', () => {
    const players = Array.from({ length: 9 }, (_, index) => ({ id: `player-${index + 1}`, seat: index + 1 }));

    expect(seatLayout(9, players, 'player-1').map((seat) => seat.visualOffset)).toEqual([0, 2, 3, 4, 1, 5, 6, 7, 8]);
  });

  it('provides accessible waiting, sitting-out and reconnecting status text', () => {
    expect(participantStatus({ participation: 'waiting', connected: true })).toBe('等待坐入');
    expect(participantStatus({ participation: 'sitting-out', connected: true })).toBe('暂离');
    expect(participantStatus({ participation: 'seated', connected: false })).toBe('重连宽限期');
  });

  it('uses distinct circle-border states for awaiting, acting, and inactive players', () => {
    const base = { handActive: true, currentPlayer: false, folded: false, allIn: false, participation: 'seated' as const, connected: true };
    expect(seatBorderState(base)).toBe('Waiting');
    expect(seatBorderState({ ...base, currentPlayer: true })).toBe('Acting');
    expect(seatBorderState({ ...base, folded: true })).toBe('Inactive');
    expect(seatBorderState({ ...base, allIn: true })).toBe('Inactive');
    expect(seatBorderState({ ...base, connected: false })).toBe('Inactive');
    expect(seatBorderState({ ...base, participation: 'waiting' })).toBe('Inactive');
  });

  it('never renders another folded player\'s private cards in an ordinary replay', () => {
    expect(canRenderReplayHole({ viewerId: 'a', playerId: 'a', settledBy: 'fold', folded: false })).toBe(true);
    expect(canRenderReplayHole({ viewerId: 'a', playerId: 'b', settledBy: 'fold', folded: true })).toBe(false);
    expect(canRenderReplayHole({ viewerId: 'a', playerId: 'b', settledBy: 'showdown', folded: false })).toBe(true);
  });

  it('identifies every payout recipient and their displayed winnings at settlement', () => {
    expect(settlementWinners([
      { id: 'a', nickname: 'Alpha' },
      { id: 'b', nickname: 'Bravo' }
    ], { a: 125, b: 75, c: 0 })).toEqual([
      { id: 'a', nickname: 'Alpha', amount: 125 },
      { id: 'b', nickname: 'Bravo', amount: 75 }
    ]);
  });
});
