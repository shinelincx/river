export type TableSoundEvent = 'deal' | 'settle' | 'action' | 'turn' | 'allIn';

export type SoundSnapshot = {
  sequence: number;
  players: Array<{ id: string; allIn: boolean }>;
  hand?: {
    number: number;
    status: 'active' | 'settled';
    board: unknown[];
    currentPlayerId?: string;
  };
};

export function tableSoundEvents(previous: SoundSnapshot, next: SoundSnapshot, viewerId: string): TableSoundEvent[] {
  const events: TableSoundEvent[] = [];
  const previousHand = previous.hand;
  const nextHand = next.hand;
  if (!nextHand) return events;

  const settledNow = previousHand?.status !== 'settled' && nextHand.status === 'settled';
  if (!previousHand || nextHand.number > previousHand.number) events.push('deal');
  else if (settledNow) events.push('settle');
  else if (nextHand.board.length > previousHand.board.length) events.push('deal');
  else if (next.sequence > previous.sequence) events.push('action');

  if (nextHand.currentPlayerId === viewerId && nextHand.currentPlayerId !== previousHand?.currentPlayerId) events.push('turn');
  const sameHand = previousHand?.number === nextHand.number;
  const newlyAllIn = next.players.some((nextPlayer) => nextPlayer.allIn && (!sameHand || !previous.players.find((item) => item.id === nextPlayer.id)?.allIn));
  if (newlyAllIn && !settledNow) events.push('allIn');
  return events;
}
