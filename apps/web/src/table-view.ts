export type SeatPlayer = { id: string; seat: number };
export type ParticipationPlayer = { participation: 'seated' | 'waiting' | 'sitting-out'; connected: boolean };
export type SeatBorderState = 'Waiting' | 'Acting' | 'Inactive';

// CSS slot numbers are not the clockwise action order on the rebuilt nine-seat table.
// Keep the physical engine order intact and translate it only at the rendering boundary.
const visualSlotsByActionOffset = {
  6: [0, 1, 2, 3, 4, 5],
  9: [0, 2, 3, 4, 1, 5, 6, 7, 8]
} as const;

export function seatLayout<T extends SeatPlayer>(maxSeats: 6 | 9, players: T[], viewerId?: string) {
  const playersBySeat = new Map(players.map((player) => [player.seat, player]));
  const viewerSeat = players.find((player) => player.id === viewerId && player.seat >= 1 && player.seat <= maxSeats)?.seat;
  return Array.from({ length: maxSeats }, (_, index) => {
    const physicalSeat = index + 1;
    const actionOffset = viewerSeat === undefined ? physicalSeat - 1 : (physicalSeat - viewerSeat + maxSeats) % maxSeats;
    return {
      physicalSeat,
      visualOffset: visualSlotsByActionOffset[maxSeats][actionOffset],
      player: playersBySeat.get(physicalSeat)
    };
  });
}

export function participantStatus(player: ParticipationPlayer): string | undefined {
  if (!player.connected && player.participation !== 'sitting-out') return '重连宽限期';
  if (player.participation === 'waiting') return '等待坐入';
  if (player.participation === 'sitting-out') return '暂离';
  return undefined;
}

export function seatBorderState(input: ParticipationPlayer & {
  handActive: boolean;
  currentPlayer: boolean;
  folded: boolean;
  allIn: boolean;
}): SeatBorderState {
  const awaitingAction = input.handActive
    && input.participation === 'seated'
    && input.connected
    && !input.folded
    && !input.allIn;
  if (awaitingAction && input.currentPlayer) return 'Acting';
  if (awaitingAction) return 'Waiting';
  return 'Inactive';
}

export function canRenderReplayHole(input: {
  viewerId: string;
  playerId: string;
  settledBy: 'fold' | 'showdown';
  folded: boolean;
}): boolean {
  return input.viewerId === input.playerId || (input.settledBy === 'showdown' && !input.folded);
}

export function settlementWinners(
  players: Array<{ id: string; nickname: string }>,
  payouts: Record<string, number> | undefined
): Array<{ id: string; nickname: string; amount: number }> {
  return Object.entries(payouts ?? {})
    .filter(([, amount]) => amount > 0)
    .map(([id, amount]) => ({ id, nickname: players.find((player) => player.id === id)?.nickname ?? '已离桌玩家', amount }));
}
