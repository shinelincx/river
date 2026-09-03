export type TableActionSound = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allIn';
export type TableSoundEvent = 'deal' | 'settle' | TableActionSound | 'turn';

export type SoundSnapshot = {
  sequence: number;
  players: Array<{ id: string; allIn: boolean }>;
  hand?: {
    number: number;
    status: 'active' | 'settled';
    board: unknown[];
    currentPlayerId?: string;
    lastAction?: { sequence: number; playerId: string; type: TableActionSound };
  };
};

export function tableSoundEvents(previous: SoundSnapshot, next: SoundSnapshot, viewerId: string): TableSoundEvent[] {
  const events: TableSoundEvent[] = [];
  const previousHand = previous.hand;
  const nextHand = next.hand;
  if (!nextHand) return events;

  const settledNow = previousHand?.status !== 'settled' && nextHand.status === 'settled';
  const actionOccurred = !!nextHand.lastAction && nextHand.lastAction.sequence !== previousHand?.lastAction?.sequence;
  if (!previousHand || nextHand.number > previousHand.number) events.push('deal');
  else if (settledNow) {
    if (actionOccurred) events.push(nextHand.lastAction!.type);
    events.push('settle');
  }
  else if (nextHand.board.length > previousHand.board.length) events.push('deal');
  else if (actionOccurred) events.push(nextHand.lastAction!.type);

  if (nextHand.currentPlayerId === viewerId && nextHand.currentPlayerId !== previousHand?.currentPlayerId) events.push('turn');
  return events;
}
