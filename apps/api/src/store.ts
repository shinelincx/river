import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PokerTable, type SerializedTableState } from './game-engine.js';

export type Player = { id: string; nickname: string; createdAt: string };
export type Room = {
  id: string; hostId: string; name: string; maxSeats: 6 | 9; smallBlind: number; bigBlind: number;
  inviteCode: string; inviteOpen: boolean; status: 'active' | 'pausing' | 'paused' | 'closing' | 'dissolved'; createdAt: string; dissolvedAt?: string;
};
export type Membership = { roomId: string; playerId: string; role: 'host' | 'member'; status: 'active' | 'closed'; joinedAt: string };
export type LedgerEntry = { id: string; roomId: string; playerId: string; actorId: string; amount: number; reason: 'initial' | 'topup' | 'hand-settlement'; idempotencyKey: string; createdAt: string };
export type Settlement = { roomId: string; playerId: string; finalChips: number; createdAt: string };
export type SerializedRiverStore = {
  players: Array<[string, Player]>;
  sessions: Array<[string, { playerId: string; expiresAt: number }]>;
  rooms: Array<[string, Room]>;
  memberships: Array<[string, Membership]>;
  ledger: LedgerEntry[];
  settlements: Settlement[];
  tables: Array<[string, SerializedTableState]>;
  pendingCredits: LedgerEntry[];
  pendingRemovals: string[];
  inviteCredentials?: Array<[string, { hash: string; version: number }]>;
};

const now = () => new Date().toISOString();
const INVITE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const inviteCode = () => {
  const symbols = [...randomBytes(12)].map((value) => INVITE_CODE_ALPHABET[value & 31]).join('');
  return `RIVER-${symbols.slice(0, 4)}-${symbols.slice(4, 8)}-${symbols.slice(8)}`;
};
const inviteHash = (code: string) => createHash('sha256').update(code.trim().toUpperCase()).digest('hex');

export class RiverStore {
  readonly players = new Map<string, Player>();
  readonly sessions = new Map<string, { playerId: string; expiresAt: number }>();
  readonly rooms = new Map<string, Room>();
  readonly memberships = new Map<string, Membership>();
  readonly ledger: LedgerEntry[] = [];
  readonly settlements: Settlement[] = [];
  readonly tables = new Map<string, PokerTable>();
  private readonly pendingCredits: LedgerEntry[] = [];
  private readonly pendingRemovals = new Set<string>();
  private readonly inviteCredentials = new Map<string, { hash: string; version: number }>();

  exportState(): SerializedRiverStore {
    return this.serializedState(true);
  }

  exportPersistenceState(): SerializedRiverStore {
    return this.serializedState(false);
  }

  private serializedState(includeHistory: boolean): SerializedRiverStore {
    return {
      players: structuredClone([...this.players.entries()]),
      sessions: structuredClone([...this.sessions.entries()]),
      rooms: structuredClone([...this.rooms.entries()]),
      memberships: structuredClone([...this.memberships.entries()]),
      ledger: includeHistory ? structuredClone(this.ledger) : [],
      settlements: includeHistory ? structuredClone(this.settlements) : [],
      tables: [...this.tables.entries()].map(([roomId, table]) => [roomId, table.exportState()]),
      pendingCredits: structuredClone(this.pendingCredits),
      pendingRemovals: [...this.pendingRemovals],
      inviteCredentials: structuredClone([...this.inviteCredentials.entries()])
    };
  }

  static fromState(state: SerializedRiverStore): RiverStore {
    const store = new RiverStore();
    store.restoreState(state);
    return store;
  }

  restoreState(state: SerializedRiverStore): void {
    this.players.clear();
    this.sessions.clear();
    this.rooms.clear();
    this.memberships.clear();
    this.ledger.splice(0);
    this.settlements.splice(0);
    this.tables.clear();
    this.pendingCredits.splice(0);
    this.pendingRemovals.clear();
    this.inviteCredentials.clear();
    for (const [key, value] of state.players) this.players.set(key, structuredClone(value));
    for (const [key, value] of state.sessions) this.sessions.set(key, structuredClone(value));
    for (const [key, value] of state.rooms) this.rooms.set(key, structuredClone(value));
    for (const [key, value] of state.memberships) this.memberships.set(key, structuredClone(value));
    this.ledger.push(...structuredClone(state.ledger));
    this.settlements.push(...structuredClone(state.settlements));
    for (const [key, value] of state.tables) this.tables.set(key, PokerTable.fromState(value));
    this.pendingCredits.push(...structuredClone(state.pendingCredits));
    for (const key of state.pendingRemovals) this.pendingRemovals.add(key);
    for (const [roomId, credential] of state.inviteCredentials ?? state.rooms.map(([roomId, room]) => [roomId, { hash: inviteHash(room.inviteCode), version: 1 }] as [string, { hash: string; version: number }])) {
      this.inviteCredentials.set(roomId, structuredClone(credential));
    }
  }

  createGuest(nickname: string): { player: Player; sessionId: string } {
    const player = { id: randomUUID(), nickname: nickname.trim(), createdAt: now() };
    const sessionId = randomUUID();
    this.players.set(player.id, player);
    this.sessions.set(sessionId, { playerId: player.id, expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 30 });
    return { player, sessionId };
  }

  playerForSession(sessionId?: string): Player | undefined {
    const session = sessionId && this.sessions.get(sessionId);
    if (!session || session.expiresAt < Date.now()) return undefined;
    return this.players.get(session.playerId);
  }

  createRoom(hostId: string, input: { name: string; maxSeats: 6 | 9; smallBlind: number; initialChips: number }): Room {
    if (!input.name.trim() || input.name.trim().length > 20) throw new Error('房间名称需为 1–20 个字符');
    if (input.maxSeats !== 6 && input.maxSeats !== 9) throw new Error('座位数仅支持 6 人或 9 人');
    if (![10, 20, 50, 100].includes(input.smallBlind)) throw new Error('盲注仅支持 10/20、20/40、50/100 或 100/200');
    if (!Number.isSafeInteger(input.initialChips) || input.initialChips < input.smallBlind * 2) throw new Error('初始积分至少为大盲的两倍');
    let code = inviteCode(); while ([...this.rooms.values()].some((room) => room.inviteCode === code)) code = inviteCode();
    const room: Room = { id: randomUUID(), hostId, name: input.name.trim(), maxSeats: input.maxSeats, smallBlind: input.smallBlind, bigBlind: input.smallBlind * 2, inviteCode: code, inviteOpen: true, status: 'active', createdAt: now() };
    this.rooms.set(room.id, room);
    this.inviteCredentials.set(room.id, { hash: inviteHash(code), version: 1 });
    this.memberships.set(this.memberKey(room.id, hostId), { roomId: room.id, playerId: hostId, role: 'host', status: 'active', joinedAt: now() });
    this.addLedger(room.id, hostId, hostId, input.initialChips, 'initial', `room-create:${room.id}`);
    return room;
  }

  joinByCode(playerId: string, code: string): Room {
    const requestedHash = inviteHash(code);
    const roomId = [...this.inviteCredentials.entries()].find(([, credential]) => credential.hash === requestedHash)?.[0];
    const room = roomId ? this.rooms.get(roomId) : undefined;
    if (!room || room.status === 'closing' || room.status === 'dissolved' || !room.inviteOpen) throw new Error('邀请码无效、已关闭或房间已解散');
    const key = this.memberKey(room.id, playerId);
    const existing = this.memberships.get(key);
    if (existing?.status === 'active') return room;
    if (existing?.status === 'closed') throw new Error('你已被移除该房间');
    this.memberships.set(key, { roomId: room.id, playerId, role: 'member', status: 'active', joinedAt: now() });
    return room;
  }

  roomView(roomId: string, viewerId: string) {
    const room = this.room(roomId);
    const viewer = this.requireMember(roomId, viewerId, true);
    const isHost = viewer.role === 'host';
    const visibleMemberships = isHost ? this.activeMembers(roomId) : [viewer];
    return {
      ...room,
      inviteCode: isHost ? room.inviteCode : '',
      members: visibleMemberships.map((membership) => {
        const player = this.players.get(membership.playerId)!;
        return { id: player.id, nickname: player.nickname, role: membership.role, chips: this.currentChips(roomId, player.id), joinedAt: membership.joinedAt };
      }),
      isHost
    };
  }

  roomsFor(playerId: string) {
    return [...this.memberships.values()].filter((membership) => membership.playerId === playerId && membership.status === 'active').map((membership) => {
      const room = this.rooms.get(membership.roomId)!;
      return { ...room, inviteCode: membership.role === 'host' ? room.inviteCode : '', role: membership.role, memberCount: this.activeMembers(room.id).length, chips: this.currentChips(room.id, playerId) };
    });
  }

  historyFor(playerId: string) {
    return this.settlements.filter((settlement) => settlement.playerId === playerId).map((settlement) => {
      const room = this.rooms.get(settlement.roomId);
      return { ...settlement, room: room && { ...room, inviteCode: '', inviteOpen: false } };
    });
  }

  setInvite(hostId: string, roomId: string, open: boolean): Room {
    const room = this.requireHost(roomId, hostId);
    if (room.inviteOpen === open) return room;
    if (open) {
      this.issueFreshInvite(room);
      room.inviteOpen = true;
    } else {
      const previous = this.inviteCredentials.get(room.id);
      this.inviteCredentials.set(room.id, { hash: inviteHash(randomBytes(32).toString('base64url')), version: (previous?.version ?? 0) + 1 });
      room.inviteOpen = false;
    }
    return room;
  }

  rotateInvite(hostId: string, roomId: string): Room {
    const room = this.requireHost(roomId, hostId);
    this.issueFreshInvite(room);
    room.inviteOpen = true;
    return room;
  }

  pause(hostId: string, roomId: string): Room {
    const room = this.requireHost(roomId, hostId);
    if (room.status === 'closing' || room.status === 'dissolved') throw new Error('牌局正在关闭或已解散');
    const table = this.tables.get(roomId);
    const hand = table?.snapshot(hostId).hand;
    if (!hand?.status && table?.snapshot(hostId).preparing) table.cancelPreparation('room_paused');
    room.status = hand?.status === 'active' ? 'pausing' : 'paused';
    return room;
  }

  resume(hostId: string, roomId: string): Room {
    const room = this.requireHost(roomId, hostId);
    if (room.status === 'closing' || room.status === 'dissolved') throw new Error('牌局正在关闭或已解散');
    room.status = 'active';
    return room;
  }

  removeMember(hostId: string, roomId: string, playerId: string): Membership {
    this.requireHost(roomId, hostId);
    if (playerId === hostId) throw new Error('不支持移除房主');
    const membership = this.requireMember(roomId, playerId, true);
    const hand = this.tables.get(roomId)?.snapshot(hostId).hand;
    if (hand?.status === 'active') this.pendingRemovals.add(this.memberKey(roomId, playerId));
    else this.finalizeRemoval(roomId, playerId);
    return membership;
  }

  credit(hostId: string, roomId: string, playerId: string, amount: number, idempotencyKey: string): LedgerEntry {
    const room = this.requireHost(roomId, hostId);
    this.requireMember(room.id, playerId, true);
    if (!idempotencyKey) throw new Error('缺少幂等键');
    const previous = this.ledger.find((entry) => entry.idempotencyKey === idempotencyKey);
    if (previous) return previous;
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('补充积分必须为正整数');
    const entry = this.addLedger(roomId, playerId, hostId, amount, 'topup', idempotencyKey);
    const table = this.tables.get(roomId);
    const tablePlayer = table?.players.find((player) => player.id === playerId);
    if (table?.snapshot(hostId).hand?.status === 'active' && tablePlayer) this.pendingCredits.push(entry);
    else if (tablePlayer) table!.topUp(playerId, amount);
    return entry;
  }

  ledgerFor(roomId: string, viewerId: string): LedgerEntry[] {
    this.requireMember(roomId, viewerId, false);
    const host = this.room(roomId).hostId === viewerId;
    return this.ledger.filter((entry) => entry.roomId === roomId && (host || entry.playerId === viewerId));
  }

  authorizeHandHistory(roomId: string, viewerId: string): void {
    this.requireMember(roomId, viewerId, false);
  }

  dissolve(hostId: string, roomId: string): Room {
    const room = this.requireHost(roomId, hostId);
    room.inviteOpen = false;
    const table = this.tables.get(roomId);
    if (!table?.snapshot(hostId).hand?.status && table?.snapshot(hostId).preparing) table.cancelPreparation('room_dissolved');
    if (table?.snapshot(hostId).hand?.status === 'active') { room.status = 'closing'; return room; }
    this.finalizeDissolve(roomId); return room;
  }

  finalizeDissolve(roomId: string): void {
    const room = this.room(roomId);
    if (room.status === 'dissolved') return;
    const table = this.tables.get(roomId);
    for (const membership of this.activeMembers(roomId)) {
      const stack = table?.players.find((player) => player.id === membership.playerId)?.stack ?? this.balance(roomId, membership.playerId);
      this.settlements.push({ roomId, playerId: membership.playerId, finalChips: stack, createdAt: now() });
      membership.status = 'closed';
    }
    room.status = 'dissolved'; room.dissolvedAt = now();
  }

  tableFor(roomId: string, playerId: string): PokerTable {
    const room = this.room(roomId); this.requireMember(roomId, playerId, true);
    if (room.status === 'closing' || room.status === 'dissolved') throw new Error('牌局正在关闭或已解散');
    let table = this.tables.get(roomId);
    if (!table) { table = new PokerTable(roomId, room.smallBlind, room.bigBlind, room.maxSeats); this.tables.set(roomId, table); }
    const player = this.players.get(playerId)!;
    table.addPlayer({ id: player.id, nickname: player.nickname, stack: this.balance(roomId, playerId) });
    return table;
  }

  startTable(hostId: string, roomId: string): PokerTable {
    const room = this.requireHost(roomId, hostId);
    if (room.status !== 'active') throw new Error('牌桌已暂停或正在关闭');
    const table = this.tables.get(roomId);
    if (!table) throw new Error('请先进入牌桌');
    table.startNextHand();
    const snapshot = table.snapshot(hostId);
    if (snapshot.hand?.status !== 'active' && !snapshot.preparing) throw new Error('至少需要两位拥有积分的玩家入桌');
    return table;
  }

  maybeFinalize(roomId: string): void {
    const room = this.rooms.get(roomId);
    const host = room && room.hostId;
    if (!room || !host) return;
    const hand = this.tables.get(roomId)?.snapshot(host).hand;
    if (hand?.status === 'settled') {
      this.recordHandSettlement(roomId, host);
      this.applyPendingCredits(roomId);
      this.applyPendingRemovals(roomId);
      if (room.status === 'pausing') room.status = 'paused';
    }
    if (room.status === 'closing' && hand?.status === 'settled') this.finalizeDissolve(roomId);
  }

  private applyPendingRemovals(roomId: string): void {
    for (const key of [...this.pendingRemovals]) {
      if (!key.startsWith(`${roomId}:`)) continue;
      this.finalizeRemoval(roomId, key.slice(roomId.length + 1));
      this.pendingRemovals.delete(key);
    }
  }

  private recordHandSettlement(roomId: string, actorId: string): void {
    const table = this.tables.get(roomId);
    if (!table) return;
    for (const delta of table.settlementDeltas()) {
      const idempotencyKey = `hand-settlement:${delta.handId}:${delta.playerId}`;
      if (this.ledger.some((entry) => entry.idempotencyKey === idempotencyKey)) continue;
      this.addLedger(roomId, delta.playerId, actorId, delta.amount, 'hand-settlement', idempotencyKey);
    }
  }

  private finalizeRemoval(roomId: string, playerId: string): void {
    const membership = this.requireMember(roomId, playerId, true);
    const table = this.tables.get(roomId);
    if (table?.snapshot(this.room(roomId).hostId).preparing) table.cancelPreparation('member_removed');
    const finalChips = table?.players.find((player) => player.id === playerId)?.stack ?? this.balance(roomId, playerId);
    this.settlements.push({ roomId, playerId, finalChips, createdAt: now() });
    membership.status = 'closed';
    table?.removePlayer(playerId);
  }

  private applyPendingCredits(roomId: string): void {
    const table = this.tables.get(roomId);
    if (!table) return;
    for (let index = this.pendingCredits.length - 1; index >= 0; index--) {
      const entry = this.pendingCredits[index];
      if (entry.roomId !== roomId) continue;
      if (table.players.some((player) => player.id === entry.playerId)) table.topUp(entry.playerId, entry.amount);
      this.pendingCredits.splice(index, 1);
    }
  }

  private addLedger(roomId: string, playerId: string, actorId: string, amount: number, reason: LedgerEntry['reason'], idempotencyKey: string): LedgerEntry {
    const entry = { id: randomUUID(), roomId, playerId, actorId, amount, reason, idempotencyKey, createdAt: now() };
    this.ledger.push(entry); return entry;
  }
  private issueFreshInvite(room: Room): void {
    let code = inviteCode(); while ([...this.rooms.values()].some((item) => item.id !== room.id && item.inviteCode === code)) code = inviteCode();
    room.inviteCode = code;
    const previous = this.inviteCredentials.get(room.id);
    this.inviteCredentials.set(room.id, { hash: inviteHash(code), version: (previous?.version ?? 0) + 1 });
  }
  private currentChips(roomId: string, playerId: string): number {
    return this.tables.get(roomId)?.players.find((player) => player.id === playerId)?.stack ?? this.balance(roomId, playerId);
  }
  private balance(roomId: string, playerId: string): number { return this.ledger.filter((entry) => entry.roomId === roomId && entry.playerId === playerId).reduce((sum, entry) => sum + entry.amount, 0); }
  private room(roomId: string): Room { const room = this.rooms.get(roomId); if (!room) throw new Error('房间不存在'); return room; }
  private activeMembers(roomId: string): Membership[] { return [...this.memberships.values()].filter((membership) => membership.roomId === roomId && membership.status === 'active'); }
  private requireMember(roomId: string, playerId: string, active: boolean): Membership { const member = this.memberships.get(this.memberKey(roomId, playerId)); if (!member || (active && member.status !== 'active')) throw new Error('你不是该房间的受邀成员'); return member; }
  private requireHost(roomId: string, playerId: string): Room { const room = this.room(roomId); if (room.hostId !== playerId) throw new Error('仅房主可执行此操作'); return room; }
  private memberKey(roomId: string, playerId: string) { return `${roomId}:${playerId}`; }
}
