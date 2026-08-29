import { describe, expect, it } from 'vitest';
import { inviteCodeFromPath } from './invite-route';
import { canRenderReplayHole, participantStatus, seatLayout } from './table-view';

describe('Web requirement acceptance', () => {
  it('parses a valid /join/:inviteCode deep link and rejects unrelated paths', () => {
    expect(inviteCodeFromPath('/join/river-Ab_123')).toBe('RIVER-AB_123');
    expect(inviteCodeFromPath('/join/RIVER-ABC/extra')).toBeUndefined();
    expect(inviteCodeFromPath('/rooms/RIVER-ABC')).toBeUndefined();
  });

  it.each([6, 9] as const)('keeps the local player at the bottom without changing physical seats on a %i-seat table', (maxSeats) => {
    const players = [{ id: 'left', seat: maxSeats }, { id: 'hero', seat: 3 }, { id: 'right', seat: 4 }];
    const layout = seatLayout(maxSeats, 3, players);

    expect(layout.find((seat) => seat.player?.id === 'hero')).toMatchObject({ physicalSeat: 3, visualOffset: 0 });
    expect(layout.find((seat) => seat.player?.id === 'left')?.physicalSeat).toBe(maxSeats);
    expect(layout.find((seat) => seat.player?.id === 'right')).toMatchObject({ physicalSeat: 4, visualOffset: 1 });
  });

  it('provides accessible waiting, sitting-out and reconnecting status text', () => {
    expect(participantStatus({ participation: 'waiting', connected: true })).toBe('等待坐入');
    expect(participantStatus({ participation: 'sitting-out', connected: true })).toBe('暂离');
    expect(participantStatus({ participation: 'seated', connected: false })).toBe('重连宽限期');
  });

  it('never renders another folded player\'s private cards in an ordinary replay', () => {
    expect(canRenderReplayHole({ viewerId: 'a', playerId: 'a', settledBy: 'fold', folded: false })).toBe(true);
    expect(canRenderReplayHole({ viewerId: 'a', playerId: 'b', settledBy: 'fold', folded: true })).toBe(false);
    expect(canRenderReplayHole({ viewerId: 'a', playerId: 'b', settledBy: 'showdown', folded: false })).toBe(true);
  });
});
