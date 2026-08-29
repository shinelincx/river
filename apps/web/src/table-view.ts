export type SeatPlayer = { id: string; seat: number };
export type ParticipationPlayer = { participation: 'seated' | 'waiting' | 'sitting-out'; connected: boolean };

export function seatLayout<T extends SeatPlayer>(maxSeats: 6 | 9, heroSeat: number, players: T[]) {
  const playersBySeat = new Map(players.map((player) => [player.seat, player]));
  return Array.from({ length: maxSeats }, (_, index) => {
    const physicalSeat = index + 1;
    return {
      physicalSeat,
      visualOffset: (physicalSeat - heroSeat + maxSeats) % maxSeats,
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

export function canRenderReplayHole(input: {
  viewerId: string;
  playerId: string;
  settledBy: 'fold' | 'showdown';
  folded: boolean;
}): boolean {
  return input.viewerId === input.playerId || (input.settledBy === 'showdown' && !input.folded);
}
