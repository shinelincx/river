import { createHash, randomBytes } from 'node:crypto';

export type Suit = 'S' | 'H' | 'D' | 'C';
export type Card = { rank: number; suit: Suit };
export type Action = { type: 'fold' | 'check' | 'call' | 'raise'; amount?: number };
export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
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
  folded: boolean;
  allIn: boolean;
  bet: number;
  contribution: number;
  hole: Card[];
};

type EngineEvent = { sequence: number; type: string; payload: Record<string, unknown> };
type HandState = {
  number: number;
  seed: string;
  commitment: string;
  deck: Card[];
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
  settledBy?: 'fold' | 'showdown';
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

function shuffledDeck(): { seed: string; deck: Card[]; commitment: string } {
  const seed = randomBytes(32).toString('hex');
  const deck = SUITS.flatMap((suit) => Array.from({ length: 13 }, (_, i) => ({ rank: i + 2, suit })));
  // The randomness is server-only and committed before any action is accepted.
  for (let index = deck.length - 1; index > 0; index--) {
    const random = randomBytes(4).readUInt32BE(0) % (index + 1);
    [deck[index], deck[random]] = [deck[random], deck[index]];
  }
  const commitment = createHash('sha256').update(`${seed}:${deck.map(cardText).join(',')}`).digest('hex');
  return { seed, deck, commitment };
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
  private hand?: HandState;
  private eventSequence = 0;
  private handNumber = 0;
  private lastDealerSeat = 0;

  constructor(readonly roomId: string, readonly smallBlind: number, readonly bigBlind: number, readonly maxSeats: 6 | 9) {}

  addPlayer(input: { id: string; nickname: string; stack: number }): GamePlayer {
    const existing = this.players.find((player) => player.id === input.id);
    if (existing) { existing.connected = true; return existing; }
    if (this.players.length >= this.maxSeats) throw new Error('牌桌已满');
    const used = new Set(this.players.map((player) => player.seat));
    const seat = Array.from({ length: this.maxSeats }, (_, i) => i + 1).find((value) => !used.has(value));
    if (!seat) throw new Error('牌桌已满');
    const player: GamePlayer = { ...input, seat, connected: true, folded: false, allIn: false, bet: 0, contribution: 0, hole: [] };
    this.players.push(player);
    this.record('player_joined', { playerId: player.id, seat: player.seat });
    return player;
  }

  setConnected(playerId: string, connected: boolean): void {
    const player = this.player(playerId);
    player.connected = connected;
    this.record('presence', { playerId, connected });
  }

  topUp(playerId: string, amount: number): void {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('积分必须为正整数');
    const player = this.player(playerId);
    player.stack += amount;
    this.record('chips_added', { playerId, amount });
  }

  takeAction(playerId: string, action: Action): void {
    const hand = this.activeHand();
    if (hand.currentPlayerId !== playerId) throw new Error('尚未轮到你行动');
    const player = this.player(playerId);
    if (player.folded || player.allIn) throw new Error('此玩家不能行动');
    const owed = hand.currentBet - player.bet;
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
      const raiseSize = target - hand.currentBet;
      this.commit(player, added);
      hand.currentBet = player.bet;
      if (target >= minimumTarget) hand.minRaise = raiseSize;
      hand.pending = new Set(this.eligible().filter((p) => p.id !== player.id && !p.allIn).map((p) => p.id));
    }
    hand.actedAtBet.set(playerId, hand.currentBet);
    hand.pending.delete(playerId);
    this.record('action', { playerId, type: action.type, amount: action.amount, street: hand.street });
    this.progress();
  }

  timeout(playerId: string): void {
    const hand = this.activeHand();
    if (hand.currentPlayerId !== playerId) return;
    const player = this.player(playerId);
    this.takeAction(playerId, { type: hand.currentBet === player.bet ? 'check' : 'fold' });
  }

  startNextHand(): void {
    if (!this.hand || this.hand.status === 'settled') this.startHand();
  }

  canStartHand(): boolean {
    return this.players.filter((player) => player.stack > 0).length >= 2;
  }

  snapshot(viewerId: string) {
    const hand = this.hand;
    const pots = hand ? this.potBreakdown() : [];
    return {
      roomId: this.roomId,
      sequence: this.eventSequence,
      players: this.players.map(({ id, nickname, seat, stack, connected, folded, allIn, bet, contribution, hole }) => ({
        id, nickname, seat, stack, connected, folded, allIn, bet, contribution,
        hole: hand && (id === viewerId || (hand.status === 'settled' && hand.settledBy === 'showdown' && !folded)) ? hole : undefined
      })),
      hand: hand && {
        number: hand.number, commitment: hand.commitment, board: hand.board, street: hand.street,
        dealerSeat: hand.dealerSeat, smallBlindSeat: hand.smallBlindSeat, bigBlindSeat: hand.bigBlindSeat,
        currentPlayerId: hand.currentPlayerId, currentBet: hand.currentBet, minRaise: hand.minRaise, status: hand.status,
        potTotal: pots.reduce((sum, pot) => sum + pot.amount, 0), pots, legalActions: this.legalActions(viewerId)
      }
    };
  }

  get recentEvents(): EngineEvent[] { return this.events.slice(-100); }

  private startHand(): void {
    const ready = this.players.filter((player) => player.stack > 0);
    if (ready.length < 2) return;
    const dealer = nextSeat(ready, this.lastDealerSeat);
    this.lastDealerSeat = dealer.seat;
    for (const player of this.players) Object.assign(player, { folded: false, allIn: false, bet: 0, contribution: 0, hole: [] });
    const { seed, deck, commitment } = shuffledDeck();
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
      number: ++this.handNumber, seed, deck, commitment, board: [], street: 'preflop', dealerSeat: dealer.seat,
      smallBlindSeat: small.seat, bigBlindSeat: big.seat,
      currentPlayerId: first?.id, currentBet: this.bigBlind, minRaise: this.bigBlind,
      pending: new Set(ready.filter((p) => !p.allIn).map((p) => p.id)), actedAtBet: new Map(), status: 'active'
    };
    this.record('hand_started', { number: this.hand.number, commitment, dealerSeat: dealer.seat, smallBlind: small.id, bigBlind: big.id });
    if (!first) this.advanceStreet();
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
    this.record('street_started', { street: hand.street, board: hand.board });
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
    const refund = this.returnUncalled();
    const pots = this.potBreakdown();
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
    hand.status = 'settled';
    hand.street = 'showdown';
    hand.currentPlayerId = undefined;
    hand.pending.clear();
    hand.settledBy = settledBy;
    this.record('hand_settled', { board: hand.board, pots, refund, payouts, settledBy, seed: hand.seed, commitment: hand.commitment });
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
