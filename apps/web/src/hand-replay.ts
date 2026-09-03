import type { HandReplay } from './api';

export type ReplayCard = { rank: number; suit: string };
export type ReplayStageId = 'preflop' | 'flop' | 'turn' | 'river' | 'result';

export type ReplayMoment = {
  sequence: number;
  kind: 'blinds' | 'action' | 'refund' | 'payout';
  street: ReplayStageId;
  playerId?: string;
  secondaryPlayerId?: string;
  action?: 'fold' | 'check' | 'call' | 'raise';
  amount?: number;
  secondaryAmount?: number;
  committedAmount?: number;
  contributionAfter?: number;
  betAfter?: number;
  stackAfter?: number;
  timedOut?: boolean;
};

export type ReplayStage = {
  id: ReplayStageId;
  label: string;
  board: ReplayCard[];
  moments: ReplayMoment[];
};

const stageLabels: Record<ReplayStageId, string> = {
  preflop: '翻牌前',
  flop: '翻牌',
  turn: '转牌',
  river: '河牌',
  result: '结算'
};

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function stageValue(value: unknown): ReplayStageId {
  return value === 'flop' || value === 'turn' || value === 'river' ? value : 'preflop';
}

function actionValue(value: unknown): ReplayMoment['action'] {
  return value === 'fold' || value === 'check' || value === 'call' || value === 'raise' ? value : undefined;
}

export function buildReplayStages(replay: HandReplay): ReplayStage[] {
  if (replay.timeline) return replay.timeline;
  /* Migration fallback for locally cached pre-projection replays. */
  const stages = new Map<ReplayStageId, ReplayStage>(
    (['preflop', 'flop', 'turn', 'river', 'result'] as const).map((id) => [id, {
      id,
      label: stageLabels[id],
      board: id === 'flop' && replay.board.length >= 3 ? replay.board.slice(0, 3)
        : id === 'turn' && replay.board.length >= 4 ? replay.board.slice(0, 4)
          : id === 'river' && replay.board.length >= 5 ? replay.board.slice(0, 5)
            : [],
      moments: []
    }])
  );

  for (const event of replay.events ?? []) {
    const payload = event.payload;
    if (event.type === 'blinds_posted') {
      stages.get('preflop')?.moments.push({
        sequence: event.sequence,
        kind: 'blinds',
        street: 'preflop',
        playerId: stringValue(payload.smallBlindPlayerId),
        secondaryPlayerId: stringValue(payload.bigBlindPlayerId),
        amount: numberValue(payload.smallBlindAmount),
        secondaryAmount: numberValue(payload.bigBlindAmount)
      });
    }
    if (event.type === 'action') {
      const street = stageValue(payload.street);
      stages.get(street)?.moments.push({
        sequence: event.sequence,
        kind: 'action',
        street,
        playerId: stringValue(payload.playerId),
        action: actionValue(payload.type),
        amount: numberValue(payload.amount),
        committedAmount: numberValue(payload.committedAmount),
        contributionAfter: numberValue(payload.contributionAfter),
        betAfter: numberValue(payload.betAfter),
        stackAfter: numberValue(payload.stackAfter),
        timedOut: payload.source === 'timeout'
      });
    }
    if (event.type === 'uncalled_returned') {
      stages.get('result')?.moments.push({
        sequence: event.sequence,
        kind: 'refund',
        street: 'result',
        playerId: stringValue(payload.playerId),
        amount: numberValue(payload.amount)
      });
    }
    if (event.type === 'payout_awarded') {
      stages.get('result')?.moments.push({
        sequence: event.sequence,
        kind: 'payout',
        street: 'result',
        playerId: stringValue(payload.playerId),
        amount: numberValue(payload.amount)
      });
    }
  }

  return [...stages.values()].filter((stage) => stage.id === 'preflop'
    || stage.id === 'result'
    || stage.moments.length > 0
    || stage.board.length > 0);
}

export function describeReplayMoment(
  moment: ReplayMoment,
  playerName: (playerId?: string) => string,
  formatAmount: (amount: number) => string
): { title: string; detail?: string; tone: 'neutral' | 'positive' | 'danger' | 'gold' } {
  const amount = formatAmount(moment.amount ?? 0);
  if (moment.kind === 'blinds') {
    return {
      title: `${playerName(moment.playerId)} 支付小盲 ${amount}`,
      detail: `${playerName(moment.secondaryPlayerId)} 支付大盲 ${formatAmount(moment.secondaryAmount ?? 0)}`,
      tone: 'gold'
    };
  }
  if (moment.kind === 'refund') return { title: `${playerName(moment.playerId)} 退回 ${amount}`, detail: '无人跟注的积分已退回', tone: 'neutral' };
  if (moment.kind === 'payout') return { title: `${playerName(moment.playerId)} 获得 ${amount}`, detail: '底池派奖', tone: 'positive' };

  const name = playerName(moment.playerId);
  const timeout = moment.timedOut ? '超时自动 · ' : '';
  const action = moment.action === 'fold' ? '弃牌'
    : moment.action === 'check' ? '过牌'
      : moment.action === 'call' ? (moment.stackAfter === 0 ? `跟注全下 ${formatAmount(moment.committedAmount ?? 0)}` : `跟注 ${formatAmount(moment.committedAmount ?? 0)}`)
        : moment.action === 'raise' ? (moment.stackAfter === 0 ? `全下至 ${formatAmount(moment.betAfter ?? moment.amount ?? 0)}`
          : moment.street !== 'preflop' && moment.committedAmount === moment.betAfter ? `下注 ${formatAmount(moment.betAfter ?? moment.amount ?? 0)}`
            : `加注至 ${formatAmount(moment.betAfter ?? moment.amount ?? 0)}`)
          : '行动';
  const details = [
    (moment.contributionAfter ?? 0) > 0 ? `本手累计 ${formatAmount(moment.contributionAfter ?? 0)}` : undefined,
    moment.stackAfter !== undefined ? `剩余 ${formatAmount(moment.stackAfter)}` : undefined
  ].filter(Boolean).join(' · ');
  return {
    title: `${name} ${action}`,
    detail: `${timeout}${details}` || undefined,
    tone: moment.action === 'fold' ? 'danger' : moment.stackAfter === 0 ? 'gold' : 'neutral'
  };
}
