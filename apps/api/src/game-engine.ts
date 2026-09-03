import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { verifyAuditMaterial } from '../../../packages/audit-verifier/index.js';

export type Suit = 'S' | 'H' | 'D' | 'C';
export type Card = { rank: number; suit: Suit };
export type Action = { type: 'fold' | 'check' | 'call' | 'raise'; amount?: number };
export type AnnouncedActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allIn';
export type ActionCommand = { actionId: string; handId: string; version: number; type: string; raiseTo?: number };
export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
export type Participation = 'seated' | 'waiting' | 'sitting-out';
export type PotView = { amount: number; eligiblePlayerIds: string[] };
export type LegalActions = {
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  canRaise: boolean;
  toCall: number;
  callAmount: number;
  minRaiseTo: number;
  maxRaiseTo: number;
  raiseAllInOnly: boolean;
};

export type GamePlayer = {
  id: string;
  nickname: string;
  seat: number;
  stack: number;
  connected: boolean;
  participation: Participation;
  folded: boolean;
  allIn: boolean;
  bet: number;
  contribution: number;
  hole: Card[];
};

export type EngineEvent = { sequence: number; type: string; payload: Record<string, unknown> };
export type SubmitActionResult = { accepted: boolean; sequence: number };
export type HandAudit = {
  handId: string;
  roomId: string;
  handNumber: number;
  algorithmVersion: 'river-shuffle-v1';
  serverSeed: string;
  commitment: string;
  playerContributions: Record<string, string>;
  participantIds: string[];
  dealOrder: string[];
  seatByPlayerId: Record<string, number>;
  dealerSeat: number;
  maxSeats: number;
  smallBlind: number;
  bigBlind: number;
  foldedPlayerIds: string[];
  contributionsBeforeRefund: Record<string, number>;
  finalContributions: Record<string, number>;
  deck: Card[];
  holeCards: Record<string, Card[]>;
  board: Card[];
  events: EngineEvent[];
  result: { pots: PotView[]; refund?: { playerId: string; amount: number }; payouts: Record<string, number>; settledBy: 'fold' | 'showdown' };
  settledAt: string;
  expiresAt: string;
};
type PreparingHandState = {
  id: string;
  number: number;
  seed: string;
  commitment: string;
  participantIds: string[];
  contributions: Map<string, string>;
};
type HandState = {
  id: string;
  number: number;
  seed: string;
  commitment: string;
  deck: Card[];
  fullDeck: Card[];
  playerContributions: Record<string, string>;
  participantIds: string[];
  startedEventSequence: number;
  board: Card[];
  street: Street;
  dealerSeat: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  currentPlayerId?: string;
  currentBet: number;
  minRaise: number;
  pending: Set<string>;
  actedAtBet: Map<string, number>;
  status: 'active' | 'settled';
  lastAction?: { sequence: number; playerId: string; type: AnnouncedActionType };
  settledBy?: 'fold' | 'showdown';
};
export type SerializedTableState = {
  roomId: string;
  smallBlind: number;
  bigBlind: number;
  maxSeats: 6 | 9;
  players: GamePlayer[];
  events: EngineEvent[];
  preparing?: Omit<PreparingHandState, 'contributions'> & { contributions: Array<[string, string]> };
  hand?: Omit<HandState, 'pending' | 'actedAtBet'> & { pending: string[]; actedAtBet: Array<[string, number]> };
  eventSequence: number;
  handNumber: number;
  lastDealerSeat: number;
  actionResults: Array<[string, { handId: string; sequence: number }]>;
  /** Legacy pre-commit contributions are intentionally ignored when restoring. */
  shuffleContributions?: Array<[string, string]>;
  audits: HandAudit[];
};

const SUITS: Suit[] = ['S', 'H', 'D', 'C'];
const cardText = (card: Card) => `${card.rank}${card.suit}`;
const bySeat = (a: GamePlayer, b: GamePlayer) => a.seat - b.seat;

function nextSeat(players: GamePlayer[], from: number, predicate = (_: GamePlayer) => true): GamePlayer {
  const ordered = [...players].sort(bySeat);
  const after = ordered.filter((p) => p.seat > from && predicate(p));
  const before = ordered.filter((p) => p.seat <= from && predicate(p));
  const player = [...after, ...before][0];
  if (!player) throw new Error('没有可用座位');
  return player;
}

const SHUFFLE_ALGORITHM_VERSION = 'river-shuffle-v1' as const;
const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000;
const PRIVATE_EVENT_KEYS = new Set(['seed', 'serverSeed', 'deck', 'fullDeck', 'holeCards', 'playerContributions']);

export function publicEngineEvent(event: EngineEvent | undefined): EngineEvent | undefined {
  if (!event) return undefined;
  return {
    ...event,
    payload: Object.fromEntries(Object.entries(event.payload).filter(([key]) => !PRIVATE_EVENT_KEYS.has(key)))
  };
}

export function deterministicDeck(serverSeed: string, playerContributions: Record<string, string>, handId: string): Card[] {
  const deck = SUITS.flatMap((suit) => Array.from({ length: 13 }, (_, i) => ({ rank: i + 2, suit })));
  const participantEntropy = Object.entries(playerContributions).sort(([a], [b]) => a.localeCompare(b)).map(([id, value]) => `${id}:${value}`).join('|');
  for (let index = deck.length - 1; index > 0; index--) {
    const random = createHash('sha256')
      .update(`${SHUFFLE_ALGORITHM_VERSION}:${serverSeed}:${handId}:${participantEntropy}:${index}`)
      .digest()
      .readUInt32BE(0) % (index + 1);
    [deck[index], deck[random]] = [deck[random], deck[index]];
  }
  return deck;
}

function serverCommitment(): { seed: string; commitment: string } {
  const seed = randomBytes(32).toString('hex');
  const commitment = createHash('sha256').update(`${SHUFFLE_ALGORITHM_VERSION}:${seed}`).digest('hex');
  return { seed, commitment };
}

export async function verifyHandAudit(audit: HandAudit, trustedCommitment?: string): Promise<boolean> {
  return (await verifyAuditMaterial(audit, trustedCommitment)).verified;
}

function combinations<T>(items: T[], size: number): T[][] {
  if (size === 0) return [[]];
  if (items.length < size) return [];
  const [head, ...tail] = items;
  return [...combinations(tail, size - 1).map((part) => [head, ...part]), ...combinations(tail, size)];
}

/** Higher lexicographic tuple wins. category: 8 straight-flush through 0 high-card. */
function evaluateFive(cards: Card[]): number[] {
  const ranks = cards.map((card) => card.rank).sort((a, b) => b - a);
  const counts = [...new Map(ranks.map((rank) => [rank, ranks.filter((value) => value === rank).length])).entries()]
    .sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const flush = cards.every((card) => card.suit === cards[0].suit);
  const unique = [...new Set(ranks)];
  const wheel = unique.length === 5 && unique.join(',') === '14,5,4,3,2';
  const straightHigh = unique.length === 5 && (unique[0] - unique[4] === 4 || wheel) ? (wheel ? 5 : unique[0]) : 0;
  if (flush && straightHigh) return [8, straightHigh];
  if (counts[0][1] === 4) return [7, counts[0][0], counts[1][0]];
  if (counts[0][1] === 3 && counts[1][1] === 2) return [6, counts[0][0], counts[1][0]];
  if (flush) return [5, ...ranks];
  if (straightHigh) return [4, straightHigh];
  if (counts[0][1] === 3) return [3, counts[0][0], ...counts.slice(1).map(([rank]) => rank)];
  if (counts[0][1] === 2 && counts[1][1] === 2) return [2, counts[0][0], counts[1][0], counts[2][0]];
  if (counts[0][1] === 2) return [1, counts[0][0], ...counts.slice(1).map(([rank]) => rank)];
  return [0, ...ranks];
}

export function compareRanks(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0) ? 1 : -1;
  }
  return 0;
}

export function evaluateSeven(cards: Card[]): number[] {
  if (cards.length < 5) throw new Error('至少需要五张牌');
  return combinations(cards, 5).map(evaluateFive).reduce((best, next) => compareRanks(next, best) > 0 ? next : best);
}

export class PokerTable {
  readonly players: GamePlayer[] = [];
  readonly events: EngineEvent[] = [];
  private preparing?: PreparingHandState;
  private hand?: HandState;
  private eventSequence = 0;
  private handNumber = 0;
  private lastDealerSeat = 0;
  private readonly actionResults = new Map<string, { handId: string; sequence: number }>();
  private readonly audits = new Map<string, HandAudit>();

  constructor(readonly roomId: string, readonly smallBlind: number, readonly bigBlind: number, readonly maxSeats: 6 | 9) {}

  exportState(): SerializedTableState {
    const hand = this.hand && {
      ...structuredClone({ ...this.hand, pending: undefined, actedAtBet: undefined }),
      pending: [...this.hand.pending],
      actedAtBet: [...this.hand.actedAtBet.entries()]
    } as SerializedTableState['hand'];
    return {
      roomId: this.roomId,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      maxSeats: this.maxSeats,
      players: structuredClone(this.players),
      events: structuredClone(this.events),
      preparing: this.preparing && {
        ...structuredClone({ ...this.preparing, contributions: undefined }),
        contributions: [...this.preparing.contributions.entries()]
      },
      hand,
      eventSequence: this.eventSequence,
      handNumber: this.handNumber,
      lastDealerSeat: this.lastDealerSeat,
      actionResults: structuredClone([...this.actionResults.entries()]),
      audits: structuredClone([...this.audits.values()])
    };
  }

  static fromState(state: SerializedTableState): PokerTable {
    const table = new PokerTable(state.roomId, state.smallBlind, state.bigBlind, state.maxSeats);
    table.players.push(...structuredClone(state.players));
    table.events.push(...state.events.map((event) => publicEngineEvent(structuredClone(event))!));
    table.preparing = state.preparing && {
      ...structuredClone(state.preparing),
      contributions: new Map(state.preparing.contributions)
    };
    table.hand = state.hand && {
      ...structuredClone(state.hand),
      pending: new Set(state.hand.pending),
      actedAtBet: new Map(state.hand.actedAtBet)
    };
    if (table.hand?.status === 'settled') {
      table.hand.seed = '';
      table.hand.deck = [];
      table.hand.fullDeck = [];
      table.hand.playerContributions = {};
      const retainedAudit = state.audits.find((audit) => audit.handId === table.hand?.id);
      if (retainedAudit) {
        for (const player of table.players) player.hole = structuredClone(retainedAudit.holeCards[player.id] ?? []);
        const eventsBySequence = new Map(table.events.map((event) => [event.sequence, event]));
        for (const event of retainedAudit.events) {
          const publicEvent = publicEngineEvent(structuredClone(event));
          if (publicEvent) eventsBySequence.set(publicEvent.sequence, publicEvent);
        }
        table.events.splice(0, table.events.length, ...[...eventsBySequence.values()].sort((left, right) => left.sequence - right.sequence));
      } else {
        for (const player of table.players) player.hole = [];
      }
    }
    table.eventSequence = state.eventSequence;
    table.handNumber = state.handNumber;
    table.lastDealerSeat = state.lastDealerSeat;
    for (const [key, value] of state.actionResults) table.actionResults.set(key, structuredClone(value));
    for (const audit of state.audits) table.audits.set(audit.handId, structuredClone(audit));
    return table;
  }

  addPlayer(input: { id: string; nickname: string; stack: number }): GamePlayer {
    const existing = this.players.find((player) => player.id === input.id);
    if (existing) { existing.connected = true; return existing; }
    const used = new Set(this.players.map((player) => player.seat).filter((seat) => seat > 0));
    const seat = Array.from({ length: this.maxSeats }, (_, i) => i + 1).find((value) => !used.has(value));
    const participation: Participation = input.stack <= 0
      ? 'sitting-out'
      : this.hand?.status === 'active' || this.preparing || !seat ? 'waiting' : 'seated';
    const player: GamePlayer = { ...input, seat: participation === 'waiting' && (this.hand?.status === 'active' || this.preparing) ? 0 : (seat ?? 0), connected: true, participation, folded: false, allIn: false, bet: 0, contribution: 0, hole: [] };
    this.players.push(player);
    this.record('player_joined', { playerId: player.id, seat: player.seat });
    return player;
  }

  setConnected(playerId: string, connected: boolean): void {
    const player = this.player(playerId);
    player.connected = connected;
    this.record('presence', { playerId, connected });
    if (!connected && this.preparing?.participantIds.includes(playerId)) this.cancelPreparation('participant_disconnected');
  }

  setShuffleContribution(playerId: string, handId: string, contribution: string): void {
    this.player(playerId);
    const preparing = this.preparing;
    if (!preparing) throw new Error('当前没有等待随机贡献的手牌');
    if (handId !== preparing.id) throw new Error('随机贡献不属于当前手牌');
    if (!preparing.participantIds.includes(playerId)) throw new Error('你不是本手候选参与者');
    if (preparing.contributions.has(playerId)) throw new Error('本手随机贡献已提交');
    if (typeof contribution !== 'string' || contribution.length < 16 || contribution.length > 128) throw new Error('随机贡献无效');
    preparing.contributions.set(playerId, contribution);
    this.record('shuffle_contribution_ready', { handId, playerId });
    if (preparing.participantIds.every((id) => preparing.contributions.has(id))) this.dealPreparedHand();
  }

  sitOut(playerId: string): void {
    const player = this.player(playerId);
    if (player.participation === 'sitting-out') return;
    if (this.preparing?.participantIds.includes(playerId)) this.cancelPreparation('participant_sat_out');
    player.participation = 'sitting-out';
    this.record('player_sat_out', { playerId });
  }

  sitOutAndReleaseSeat(playerId: string): void {
    this.sitOut(playerId);
    const player = this.player(playerId);
    if (player.seat === 0) return;
    const seat = player.seat;
    player.seat = 0;
    this.record('seat_released', { playerId, seat, reason: 'disconnect_timeout' });
  }

  sitIn(playerId: string): void {
    const player = this.player(playerId);
    if (player.stack <= 0) throw new Error('积分不足，无法坐入');
    player.participation = this.hand?.status === 'active' || this.preparing || player.seat === 0 ? 'waiting' : 'seated';
    this.record('player_sat_in', { playerId, participation: player.participation });
  }

  removePlayer(playerId: string): void {
    if (this.hand?.status === 'active' || this.preparing) throw new Error('成员只能在手牌边界移除');
    const index = this.players.findIndex((player) => player.id === playerId);
    if (index < 0) return;
    this.players.splice(index, 1);
    this.record('player_removed', { playerId });
  }

  cancelPreparation(reason: string): void {
    if (!this.preparing) return;
    const handId = this.preparing.id;
    this.preparing = undefined;
    this.record('shuffle_preparation_cancelled', { handId, reason });
  }

  hasDisconnectedSeatedPlayers(): boolean {
    return this.players.some((player) => !player.connected && player.stack > 0 && player.seat > 0 && player.participation !== 'sitting-out');
  }

  normalizePresenceAfterRestart(): void {
    for (const player of this.players) player.connected = false;
  }

  promoteWaitingPlayers(): boolean {
    if (this.hand?.status === 'active' || this.preparing) return false;
    const sequenceBefore = this.eventSequence;
    this.assignWaitingSeats();
    return this.eventSequence !== sequenceBefore;
  }

  nextAuditExpiry(): number | undefined {
    const expiries = [...this.audits.values()].map((audit) => Date.parse(audit.expiresAt)).filter(Number.isFinite);
    return expiries.length > 0 ? Math.min(...expiries) : undefined;
  }

  settlementDeltas(): Array<{ handId: string; playerId: string; amount: number }> {
    const handId = this.hand?.status === 'settled' ? this.hand.id : undefined;
    const audit = handId ? this.audits.get(handId) : undefined;
    if (!audit) return [];
    return audit.participantIds.map((playerId) => ({
      handId: audit.handId,
      playerId,
      amount: (audit.result.payouts[playerId] ?? 0) - (audit.finalContributions[playerId] ?? 0)
    }));
  }

  handHistoryFor(viewerId: string, currentTime = Date.now(), canViewPrivateRoomReplay = false) {
    const isParticipant = [...this.audits.values()].some((audit) => audit.participantIds.includes(viewerId));
    if (!canViewPrivateRoomReplay && !isParticipant) throw new Error('无权读取该牌桌手牌记录');
    return [...this.audits.values()]
      .filter((audit) => Date.parse(audit.expiresAt) > currentTime && (canViewPrivateRoomReplay || audit.participantIds.includes(viewerId)))
      .sort((a, b) => b.handNumber - a.handNumber)
      .map((audit) => ({
        handId: audit.handId,
        handNumber: audit.handNumber,
        blinds: { small: audit.smallBlind, big: audit.bigBlind },
        board: structuredClone(audit.board),
        participants: audit.participantIds.map((id) => ({ id, nickname: this.players.find((player) => player.id === id)?.nickname ?? '已离桌玩家' })),
        pointDeltas: Object.fromEntries(audit.participantIds.map((id) => [id, (audit.result.payouts[id] ?? 0) - (audit.finalContributions[id] ?? 0)])),
        pots: structuredClone(audit.result.pots),
        settledBy: audit.result.settledBy,
        settledAt: audit.settledAt,
        expiresAt: audit.expiresAt
      }));
  }

  auditFor(handId: string, viewerId: string, currentTime = Date.now()): HandAudit {
    if (this.hand?.id === handId && this.hand.status === 'active') throw new Error('手牌尚未结算');
    const audit = this.audits.get(handId);
    if (!audit) throw new Error('审计材料不存在或手牌尚未结算');
    if (!audit.participantIds.includes(viewerId)) throw new Error('仅本手参与者可读取完整审计材料');
    if (Date.parse(audit.expiresAt) <= currentTime) throw new Error('审计材料已过期');
    return structuredClone(audit);
  }

  replayFor(handId: string, viewerId: string, currentTime = Date.now(), canViewPrivateRoomReplay = false) {
    if (this.hand?.id === handId && this.hand.status === 'active') throw new Error('回放不存在或手牌尚未结算');
    const audit = this.audits.get(handId);
    if (!audit) throw new Error('回放不存在或手牌尚未结算');
    if (!audit.participantIds.includes(viewerId) && !canViewPrivateRoomReplay) throw new Error('无权读取该手回放');
    if (Date.parse(audit.expiresAt) <= currentTime) throw new Error('回放已过期');
    const foldedIds = new Set(audit.events
      .filter((event) => event.type === 'action' && event.payload.type === 'fold')
      .map((event) => event.payload.playerId as string));
    const events = audit.events.map((event) => {
      const payload = { ...event.payload };
      delete payload.seed;
      return { ...event, payload };
    });
    return {
      handId: audit.handId,
      roomId: audit.roomId,
      handNumber: audit.handNumber,
      blinds: { small: audit.smallBlind, big: audit.bigBlind },
      commitment: audit.commitment,
      board: structuredClone(audit.board),
      players: audit.participantIds.map((id) => ({
        id,
        nickname: this.players.find((player) => player.id === id)?.nickname ?? '已离桌玩家',
        pointDelta: (audit.result.payouts[id] ?? 0) - (audit.finalContributions[id] ?? 0),
        hole: id === viewerId || (audit.result.settledBy === 'showdown' && !foldedIds.has(id))
          ? structuredClone(audit.holeCards[id])
          : undefined
      })),
      events,
      result: structuredClone(audit.result),
      settledAt: audit.settledAt,
      expiresAt: audit.expiresAt
    };
  }

  purgeExpiredAudits(currentTime = Date.now()): number {
    let deleted = 0;
    for (const [handId, audit] of this.audits) {
      if (Date.parse(audit.expiresAt) <= currentTime) {
        this.audits.delete(handId);
        const sequences = new Set([
          ...audit.events.map((event) => event.sequence),
          ...this.events.filter((event) => event.payload.handId === handId).map((event) => event.sequence)
        ]);
        for (let index = this.events.length - 1; index >= 0; index--) {
          if (sequences.has(this.events[index].sequence)) this.events.splice(index, 1);
        }
        for (const [key, result] of this.actionResults) {
          if (result.handId === handId) this.actionResults.delete(key);
        }
        if (this.hand?.id === handId && this.hand.status === 'settled') {
          this.hand.seed = '';
          this.hand.deck = [];
          this.hand.fullDeck = [];
          this.hand.playerContributions = {};
          for (const player of this.players) player.hole = [];
        }
        deleted++;
      }
    }
    return deleted;
  }

  topUp(playerId: string, amount: number): void {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('积分必须为正整数');
    const player = this.player(playerId);
    const wasEmpty = player.stack === 0;
    player.stack += amount;
    if (wasEmpty && player.participation === 'sitting-out') {
      player.participation = this.hand?.status === 'active' ? 'waiting' : 'seated';
    }
    this.record('chips_added', { playerId, amount });
  }

  takeAction(
    playerId: string,
    action: Action,
    metadata: { actionId?: string; source?: 'player' | 'timeout' | 'internal'; beforeVersion?: number } = {}
  ): void {
    const hand = this.activeHand();
    if (hand.currentPlayerId !== playerId) throw new Error('尚未轮到你行动');
    const player = this.player(playerId);
    const contributionBefore = player.contribution;
    if (player.folded || player.allIn) throw new Error('此玩家不能行动');
    const owed = hand.currentBet - player.bet;
    const isOpeningBet = action.type === 'raise' && hand.currentBet === 0;
    if (action.type === 'fold') {
      player.folded = true;
    } else if (action.type === 'check') {
      if (owed !== 0) throw new Error('当前不能过牌');
    } else if (action.type === 'call') {
      if (owed <= 0) throw new Error('当前无需跟注');
      this.commit(player, Math.min(owed, player.stack));
    } else {
      const target = action.amount;
      if (!Number.isSafeInteger(target) || !target) throw new Error('加注额无效');
      if (target <= hand.currentBet) throw new Error('加注必须高于当前下注');
      const actedAt = hand.actedAtBet.get(playerId);
      if (actedAt !== undefined && hand.currentBet - actedAt < hand.minRaise) throw new Error('本轮行动未重新开放加注');
      const added = target - player.bet;
      if (added > player.stack) throw new Error('积分不足');
      const isAllIn = added === player.stack;
      const minimumTarget = hand.currentBet === 0 ? hand.minRaise : hand.currentBet + hand.minRaise;
      if (!isAllIn && target < minimumTarget) throw new Error('加注额不足');
      if (!isAllIn && target % this.smallBlind !== 0) throw new Error('下注必须是小盲的整数倍');
      const raiseSize = target - hand.currentBet;
      this.commit(player, added);
      hand.currentBet = player.bet;
      if (target >= minimumTarget) hand.minRaise = raiseSize;
      hand.pending = new Set(this.eligible().filter((p) => p.id !== player.id && !p.allIn).map((p) => p.id));
    }
    hand.actedAtBet.set(playerId, hand.currentBet);
    hand.pending.delete(playerId);
    const beforeVersion = metadata.beforeVersion ?? this.eventSequence;
    hand.lastAction = {
      sequence: beforeVersion + 1,
      playerId,
      type: player.allIn ? 'allIn' : isOpeningBet ? 'bet' : action.type
    };
    this.record('action', {
      handId: hand.id,
      playerId,
      actionId: metadata.actionId ?? `internal:${hand.id}:${beforeVersion}`,
      source: metadata.source ?? 'internal',
      beforeVersion,
      afterVersion: beforeVersion + 1,
      type: action.type,
      amount: action.amount,
      street: hand.street,
      committedAmount: player.contribution - contributionBefore,
      contributionAfter: player.contribution,
      betAfter: player.bet,
      stackAfter: player.stack,
      currentBetAfter: hand.currentBet
    });
    this.progress();
  }

  submitAction(playerId: string, input: unknown): SubmitActionResult {
    if (!input || typeof input !== 'object') throw new Error('动作请求无效');
    const command = input as Partial<ActionCommand>;
    if (typeof command.actionId !== 'string' || command.actionId.length < 1 || command.actionId.length > 128) throw new Error('actionId 无效');
    const resultKey = `${playerId}:${command.actionId}`;
    const previous = this.actionResults.get(resultKey);
    if (previous) {
      if (previous.handId !== command.handId) throw new Error('actionId 已用于其他手牌');
      return { accepted: false, sequence: previous.sequence };
    }
    const hand = this.activeHand();
    if (command.handId !== hand.id) throw new Error('手牌已变化，请同步后重试');
    if (!Number.isSafeInteger(command.version) || command.version !== this.eventSequence) throw new Error('牌桌状态已变化，请同步后重试');
    if (!['fold', 'check', 'call', 'bet', 'raise'].includes(command.type ?? '')) throw new Error('动作类型无效');
    const type = command.type === 'bet' ? 'raise' : command.type as Action['type'];
    this.takeAction(playerId, type === 'raise' ? { type, amount: command.raiseTo } : { type }, {
      actionId: command.actionId,
      source: 'player',
      beforeVersion: command.version
    });
    const result = { handId: hand.id, sequence: this.eventSequence };
    this.actionResults.set(resultKey, result);
    return { accepted: true, sequence: result.sequence };
  }

  timeout(playerId: string): boolean {
    const hand = this.activeHand();
    if (hand.currentPlayerId !== playerId) return false;
    const player = this.player(playerId);
    this.takeAction(playerId, { type: hand.currentBet === player.bet ? 'check' : 'fold' }, {
      actionId: `timeout:${hand.id}:${this.eventSequence}`,
      source: 'timeout',
      beforeVersion: this.eventSequence
    });
    return true;
  }

  startNextHand(): void {
    if ((!this.hand || this.hand.status === 'settled') && !this.preparing) this.prepareHand();
  }

  canStartHand(): boolean {
    return this.players.filter((player) => player.stack > 0 && player.connected && player.seat > 0 && player.participation === 'seated').length >= 2;
  }

  snapshot(viewerId: string) {
    const hand = this.hand;
    const pots = hand ? this.potBreakdown() : [];
    const settlement = hand?.status === 'settled' ? this.audits.get(hand.id)?.result : undefined;
    return {
      roomId: this.roomId,
      sequence: this.eventSequence,
      players: this.players.map(({ id, nickname, seat, stack, connected, participation, folded, allIn, bet, contribution, hole }) => ({
        id, nickname, seat, stack, connected, participation, folded, allIn, bet, contribution,
        hole: hand && hole.length === 2 && (id === viewerId || (hand.status === 'settled' && hand.settledBy === 'showdown' && !folded)) ? hole : undefined
      })),
      preparing: this.preparing && {
        id: this.preparing.id,
        number: this.preparing.number,
        commitment: this.preparing.commitment,
        participantIds: [...this.preparing.participantIds],
        readyPlayerIds: [...this.preparing.contributions.keys()]
      },
      hand: hand && {
        id: hand.id, number: hand.number, commitment: hand.commitment, board: hand.board, street: hand.street,
        dealerSeat: hand.dealerSeat, smallBlindSeat: hand.smallBlindSeat, bigBlindSeat: hand.bigBlindSeat,
        currentPlayerId: hand.currentPlayerId, currentBet: hand.currentBet, minRaise: hand.minRaise, status: hand.status,
        lastAction: hand.lastAction && structuredClone(hand.lastAction),
        potTotal: pots.reduce((sum, pot) => sum + pot.amount, 0), pots,
        settlement: settlement && { settledBy: settlement.settledBy, payouts: structuredClone(settlement.payouts) },
        legalActions: this.legalActions(viewerId)
      }
    };
  }

  get recentEvents(): EngineEvent[] { return this.events.slice(-100); }

  private prepareHand(): void {
    this.assignWaitingSeats();
    const ready = this.players.filter((player) => player.stack > 0 && player.connected && player.seat > 0 && player.participation === 'seated');
    if (ready.length < 2) return;
    const id = randomUUID();
    const { seed, commitment } = serverCommitment();
    this.preparing = { id, number: this.handNumber + 1, seed, commitment, participantIds: ready.map((player) => player.id), contributions: new Map() };
    this.record('shuffle_committed', { handId: id, number: this.handNumber + 1, algorithmVersion: SHUFFLE_ALGORITHM_VERSION, commitment, participantIds: ready.map((player) => player.id) });
  }

  private dealPreparedHand(): void {
    const preparing = this.preparing;
    if (!preparing) throw new Error('当前没有准备中的手牌');
    const ready = preparing.participantIds.map((id) => this.player(id));
    const dealer = nextSeat(ready, this.lastDealerSeat);
    this.lastDealerSeat = dealer.seat;
    for (const player of this.players) Object.assign(player, { folded: false, allIn: false, bet: 0, contribution: 0, hole: [] });
    const handId = preparing.id;
    const playerContributions = Object.fromEntries(preparing.contributions);
    const deck = deterministicDeck(preparing.seed, playerContributions, handId);
    const seed = preparing.seed;
    const commitment = preparing.commitment;
    const fullDeck = structuredClone(deck);
    for (const player of [...ready].sort(bySeat)) player.hole = [deck.pop()!, deck.pop()!];
    const small = ready.length === 2 ? dealer : nextSeat(ready, dealer.seat);
    const big = ready.length === 2 ? nextSeat(ready, dealer.seat) : nextSeat(ready, small.seat);
    this.commit(small, Math.min(this.smallBlind, small.stack));
    this.commit(big, Math.min(this.bigBlind, big.stack));
    const actionable = ready.filter((player) => !player.allIn);
    const first = actionable.length === 0
      ? undefined
      : ready.length === 2 && !dealer.allIn
        ? dealer
        : nextSeat(actionable, big.seat);
    this.hand = {
      id: handId, number: ++this.handNumber, seed, deck, fullDeck, playerContributions, participantIds: ready.map((player) => player.id),
      startedEventSequence: this.eventSequence + 1, commitment, board: [], street: 'preflop', dealerSeat: dealer.seat,
      smallBlindSeat: small.seat, bigBlindSeat: big.seat,
      currentPlayerId: first?.id, currentBet: this.bigBlind, minRaise: this.bigBlind,
      pending: new Set(ready.filter((p) => !p.allIn).map((p) => p.id)), actedAtBet: new Map(), status: 'active'
    };
    this.preparing = undefined;
    this.record('hand_started', { handId, number: this.hand.number, algorithmVersion: SHUFFLE_ALGORITHM_VERSION, commitment, dealerSeat: dealer.seat, smallBlind: small.id, bigBlind: big.id });
    this.record('blinds_posted', { handId, smallBlindPlayerId: small.id, smallBlindAmount: Math.min(this.smallBlind, small.contribution), bigBlindPlayerId: big.id, bigBlindAmount: Math.min(this.bigBlind, big.contribution) });
    this.record('cards_dealt', { handId, participantIds: ready.map((player) => player.id) });
    if (!first) this.advanceStreet();
  }

  private assignWaitingSeats(): void {
    const used = new Set(this.players.map((player) => player.seat).filter((seat) => seat > 0));
    for (const player of this.players.filter((item) => item.participation === 'waiting' && item.stack > 0)) {
      const seat = Array.from({ length: this.maxSeats }, (_, index) => index + 1).find((value) => !used.has(value));
      if (!seat) break;
      player.seat = seat;
      player.participation = 'seated';
      used.add(seat);
      this.record('seat_assigned', { playerId: player.id, seat });
    }
  }

  private progress(): void {
    const hand = this.activeHand();
    const contenders = this.eligible();
    if (contenders.length === 1) { this.settle(contenders); return; }
    if (hand.pending.size === 0 || contenders.every((player) => player.allIn)) { this.advanceStreet(); return; }
    const current = this.player(hand.currentPlayerId!);
    hand.currentPlayerId = nextSeat(contenders.filter((player) => !player.allIn && hand.pending.has(player.id)), current.seat).id;
  }

  private advanceStreet(): void {
    const hand = this.activeHand();
    if (hand.street === 'river') { this.settle(this.eligible()); return; }
    const count = hand.street === 'preflop' ? 3 : 1;
    hand.board.push(...Array.from({ length: count }, () => hand.deck.pop()!));
    hand.street = hand.street === 'preflop' ? 'flop' : hand.street === 'flop' ? 'turn' : 'river';
    for (const player of this.players) player.bet = 0;
    hand.currentBet = 0;
    hand.minRaise = this.bigBlind;
    const players = this.eligible().filter((player) => !player.allIn);
    hand.actedAtBet = new Map();
    this.record('street_started', { handId: hand.id, street: hand.street, board: hand.board });
    if (players.length <= 1) {
      hand.pending = new Set();
      hand.currentPlayerId = undefined;
      this.advanceStreet();
      return;
    }
    hand.pending = new Set(players.map((player) => player.id));
    hand.currentPlayerId = nextSeat(players, hand.dealerSeat).id;
  }

  private settle(contenders: GamePlayer[]): void {
    const hand = this.activeHand();
    const settledBy = contenders.length === 1 ? 'fold' : 'showdown';
    if (settledBy === 'showdown') while (hand.board.length < 5) hand.board.push(hand.deck.pop()!);
    const contributionsBeforeRefund = Object.fromEntries(hand.participantIds.map((id) => [id, this.player(id).contribution]));
    const refund = this.returnUncalled();
    const pots = this.potBreakdown();
    const finalContributions = Object.fromEntries(hand.participantIds.map((id) => [id, this.player(id).contribution]));
    const payouts: Record<string, number> = {};
    for (const pot of pots) {
      const eligible = contenders.filter((player) => pot.eligiblePlayerIds.includes(player.id));
      if (eligible.length === 0) throw new Error('底池没有符合资格的玩家');
      const winners = eligible.length === 1 ? eligible : (() => {
        const ranks = eligible.map((player) => ({ player, rank: evaluateSeven([...player.hole, ...hand.board]) }));
        const best = ranks.reduce((winner, item) => compareRanks(item.rank, winner) > 0 ? item.rank : winner, ranks[0].rank);
        return ranks.filter((item) => compareRanks(item.rank, best) === 0).map((item) => item.player);
      })();
      const orderedWinners = this.leftOfButtonOrder(winners, hand.dealerSeat);
      const share = Math.floor(pot.amount / orderedWinners.length);
      let remainder = pot.amount % orderedWinners.length;
      for (const winner of orderedWinners) payouts[winner.id] = (payouts[winner.id] ?? 0) + share + (remainder-- > 0 ? 1 : 0);
    }
    for (const [id, amount] of Object.entries(payouts)) this.player(id).stack += amount;
    for (const player of this.players) {
      if (player.stack === 0) player.participation = 'sitting-out';
    }
    hand.status = 'settled';
    hand.street = 'showdown';
    hand.currentPlayerId = undefined;
    hand.pending.clear();
    hand.settledBy = settledBy;
    if (refund) this.record('uncalled_returned', { handId: hand.id, ...refund });
    this.record('pots_built', { handId: hand.id, pots });
    for (const [playerId, amount] of Object.entries(payouts)) this.record('payout_awarded', { handId: hand.id, playerId, amount });
    this.record('hand_settled', { handId: hand.id, board: hand.board, pots, refund, payouts, settledBy, commitment: hand.commitment });
    const settledAt = new Date().toISOString();
    const dealOrder = [...hand.participantIds].sort((a, b) => this.player(a).seat - this.player(b).seat);
    this.audits.set(hand.id, {
      handId: hand.id,
      roomId: this.roomId,
      handNumber: hand.number,
      algorithmVersion: SHUFFLE_ALGORITHM_VERSION,
      serverSeed: hand.seed,
      commitment: hand.commitment,
      playerContributions: structuredClone(hand.playerContributions),
      participantIds: [...hand.participantIds],
      dealOrder,
      seatByPlayerId: Object.fromEntries(hand.participantIds.map((id) => [id, this.player(id).seat])),
      dealerSeat: hand.dealerSeat,
      maxSeats: this.maxSeats,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      foldedPlayerIds: hand.participantIds.filter((id) => this.player(id).folded),
      contributionsBeforeRefund,
      finalContributions,
      deck: structuredClone(hand.fullDeck),
      holeCards: Object.fromEntries(hand.participantIds.map((id) => [id, structuredClone(this.player(id).hole)])),
      board: structuredClone(hand.board),
      events: structuredClone(this.events.filter((event) => event.payload.handId === hand.id)),
      result: { pots: structuredClone(pots), refund: structuredClone(refund), payouts: structuredClone(payouts), settledBy },
      settledAt,
      expiresAt: new Date(Date.now() + TEN_DAYS_MS).toISOString()
    });
    if (this.events.length > 500) this.events.splice(0, this.events.length - 500);
    hand.seed = '';
    hand.deck = [];
    hand.fullDeck = [];
    hand.playerContributions = {};
  }

  private legalActions(playerId: string): LegalActions | undefined {
    const hand = this.hand;
    if (!hand || hand.status !== 'active' || hand.currentPlayerId !== playerId) return undefined;
    const player = this.player(playerId);
    const toCall = Math.max(0, hand.currentBet - player.bet);
    const maxRaiseTo = player.bet + player.stack;
    const minRaiseTo = hand.currentBet === 0 ? hand.minRaise : hand.currentBet + hand.minRaise;
    const actedAt = hand.actedAtBet.get(playerId);
    const raisingReopened = actedAt === undefined || hand.currentBet - actedAt >= hand.minRaise;
    const canRaise = raisingReopened && maxRaiseTo > hand.currentBet;
    return {
      canFold: toCall > 0,
      canCheck: toCall === 0,
      canCall: toCall > 0,
      canRaise,
      toCall,
      callAmount: Math.min(toCall, player.stack),
      minRaiseTo,
      maxRaiseTo,
      raiseAllInOnly: canRaise && maxRaiseTo < minRaiseTo
    };
  }

  private potBreakdown(): PotView[] {
    const levels = [...new Set(this.players.map((player) => player.contribution).filter((amount) => amount > 0))].sort((a, b) => a - b);
    let previous = 0;
    return levels.map((level) => {
      const involved = this.players.filter((player) => player.contribution >= level);
      const amount = (level - previous) * involved.length;
      previous = level;
      return { amount, eligiblePlayerIds: involved.filter((player) => !player.folded).map((player) => player.id) };
    }).filter((pot) => pot.amount > 0);
  }

  private returnUncalled(): { playerId: string; amount: number } | undefined {
    const ranked = this.players.filter((player) => player.contribution > 0).sort((a, b) => b.contribution - a.contribution);
    if (ranked.length === 0 || (ranked[1]?.contribution ?? 0) >= ranked[0].contribution) return undefined;
    const amount = ranked[0].contribution - (ranked[1]?.contribution ?? 0);
    ranked[0].contribution -= amount;
    ranked[0].bet = Math.max(0, ranked[0].bet - amount);
    ranked[0].stack += amount;
    return { playerId: ranked[0].id, amount };
  }

  private leftOfButtonOrder(players: GamePlayer[], dealerSeat: number): GamePlayer[] {
    return [...players].sort((a, b) => {
      const distanceA = (a.seat - dealerSeat + this.maxSeats) % this.maxSeats || this.maxSeats;
      const distanceB = (b.seat - dealerSeat + this.maxSeats) % this.maxSeats || this.maxSeats;
      return distanceA - distanceB;
    });
  }

  private commit(player: GamePlayer, amount: number): void {
    player.stack -= amount;
    player.bet += amount;
    player.contribution += amount;
    if (player.stack === 0) player.allIn = true;
  }

  private eligible(): GamePlayer[] { return this.players.filter((player) => !player.folded && player.contribution >= 0 && player.hole.length === 2); }
  private activeHand(): HandState { if (!this.hand || this.hand.status !== 'active') throw new Error('当前没有进行中的牌局'); return this.hand; }
  private player(id: string): GamePlayer { const player = this.players.find((item) => item.id === id); if (!player) throw new Error('玩家不在牌桌'); return player; }
  private record(type: string, payload: Record<string, unknown>): void { this.events.push({ sequence: ++this.eventSequence, type, payload }); }
}
