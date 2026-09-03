import type { Card, EngineEvent } from './game-engine.js';

export type ReplayStageId = 'preflop' | 'flop' | 'turn' | 'river' | 'result';
export type ReplayMoment = { sequence: number; kind: 'blinds' | 'action' | 'refund' | 'payout'; street: ReplayStageId; playerId?: string; secondaryPlayerId?: string; action?: 'fold' | 'check' | 'call' | 'raise'; amount?: number; secondaryAmount?: number; committedAmount?: number; contributionAfter?: number; betAfter?: number; stackAfter?: number; timedOut?: boolean };
export type ReplayStage = { id: ReplayStageId; label: string; board: Card[]; moments: ReplayMoment[] };

const labels: Record<ReplayStageId, string> = { preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌', result: '结算' };
const stringValue = (value: unknown) => typeof value === 'string' && value.length > 0 ? value : undefined;
const numberValue = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : undefined;
const streetValue = (value: unknown): ReplayStageId => value === 'flop' || value === 'turn' || value === 'river' ? value : 'preflop';
const actionValue = (value: unknown): ReplayMoment['action'] => value === 'fold' || value === 'check' || value === 'call' || value === 'raise' ? value : undefined;

export function projectHandReplay(board: Card[], events: EngineEvent[]): ReplayStage[] {
  const stages = new Map<ReplayStageId, ReplayStage>((['preflop', 'flop', 'turn', 'river', 'result'] as const).map((id) => [id, { id, label: labels[id], board: id === 'flop' ? board.slice(0, 3) : id === 'turn' ? board.slice(0, 4) : id === 'river' ? board.slice(0, 5) : [], moments: [] }]));
  for (const event of events) {
    const payload = event.payload;
    if (event.type === 'blinds_posted') stages.get('preflop')!.moments.push({ sequence: event.sequence, kind: 'blinds', street: 'preflop', playerId: stringValue(payload.smallBlindPlayerId), secondaryPlayerId: stringValue(payload.bigBlindPlayerId), amount: numberValue(payload.smallBlindAmount), secondaryAmount: numberValue(payload.bigBlindAmount) });
    if (event.type === 'action') { const street = streetValue(payload.street); stages.get(street)!.moments.push({ sequence: event.sequence, kind: 'action', street, playerId: stringValue(payload.playerId), action: actionValue(payload.type), amount: numberValue(payload.amount), committedAmount: numberValue(payload.committedAmount), contributionAfter: numberValue(payload.contributionAfter), betAfter: numberValue(payload.betAfter), stackAfter: numberValue(payload.stackAfter), timedOut: payload.source === 'timeout' }); }
    if (event.type === 'uncalled_returned') stages.get('result')!.moments.push({ sequence: event.sequence, kind: 'refund', street: 'result', playerId: stringValue(payload.playerId), amount: numberValue(payload.amount) });
    if (event.type === 'payout_awarded') stages.get('result')!.moments.push({ sequence: event.sequence, kind: 'payout', street: 'result', playerId: stringValue(payload.playerId), amount: numberValue(payload.amount) });
  }
  return [...stages.values()].filter((stage) => stage.id === 'preflop' || stage.id === 'result' || stage.moments.length > 0 || stage.board.length > 0);
}
