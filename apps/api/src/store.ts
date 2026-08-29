import { randomUUID } from 'node:crypto';
import { PokerTable } from './game-engine.js';

export type Player = { id: string; nickname: string; createdAt: string };
export type Room = {
  id: string; hostId: string; name: string; maxSeats: 6 | 9; smallBlind: number; bigBlind: number;
  inviteCode: string; inviteOpen: boolean; status: 'active' | 'closing' | 'dissolved'; createdAt: string; dissolvedAt?: string;
};
export type Membership = { roomId: string; playerId: string; role: 'host' | 'member'; status: 'active' | 'closed'; joinedAt: string };
export type LedgerEntry = { id: string; roomId: string; playerId: string; actorId: string; amount: number; reason: 'initial' | 'topup'; idempotencyKey: string; createdAt: string };
export type Settlement = { roomId: string; playerId: string; finalChips: number; createdAt: string };

const now = () => new Date().toISOString();
const inviteCode = () => `RIVER-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

export class RiverStore {
  readonly players = new Map<string, Player>();
  readonly sessions = new Map<string, { playerId: string; expiresAt: number }>();
  readonly rooms = new Map<string, Room>();
  readonly memberships = new Map<string, Membership>();
  readonly ledger: LedgerEntry[] = [];
  readonly settlements: Settlement[] = [];
  readonly tables = new Map<string, PokerTable>();

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
    if (!Number.isSafeInteger(input.smallBlind) || input.smallBlind < 1) throw new Error('盲注无效');
    if (!Number.isSafeInteger(input.initialChips) || input.initialChips < input.smallBlind * 2) throw new Error('初始积分至少为大盲的两倍');
    let code = inviteCode(); while ([...this.rooms.values()].some((room) => room.inviteCode === code)) code = inviteCode();
    const room: Room = { id: randomUUID(), hostId, name: input.name.trim(), maxSeats: input.maxSeats, smallBlind: input.smallBlind, bigBlind: input.smallBlind * 2, inviteCode: code, inviteOpen: true, status: 'active', createdAt: now() };
    this.rooms.set(room.id, room);
    this.memberships.set(this.memberKey(room.id, hostId), { roomId: room.id, playerId: hostId, role: 'host', status: 'active', joinedAt: now() });
    this.addLedger(room.id, hostId, hostId, input.initialChips, 'initial', `room-create:${room.id}`);
    return room;
  }

  joinByCode(playerId: string, code: string): Room {
    const room = [...this.rooms.values()].find((item) => item.inviteCode === code.trim().toUpperCase());
    if (!room || room.status !== 'active' || !room.inviteOpen) throw new Error('邀请码无效、已关闭或房间已解散');
    const key = this.memberKey(room.id, playerId);
    if (this.memberships.has(key)) return room;
    const active = this.activeMembers(room.id);
    if (active.length >= room.maxSeats) throw new Error('房间已满');
    this.memberships.set(key, { roomId: room.id, playerId, role: 'member', status: 'active', joinedAt: now() });
    return room;
  }

  roomView(roomId: string, viewerId: string) {
    const room = this.room(roomId);
    this.requireMember(roomId, viewerId, false);
    return {
      ...room,
      members: this.activeMembers(roomId).map((membership) => {
        const player = this.players.get(membership.playerId)!;
        return { id: player.id, nickname: player.nickname, role: membership.role, chips: this.currentChips(roomId, player.id), joinedAt: membership.joinedAt };
      }),
      isHost: room.hostId === viewerId
    };
  }

  roomsFor(playerId: string) {
    return [...this.memberships.values()].filter((membership) => membership.playerId === playerId).map((membership) => {
      const room = this.rooms.get(membership.roomId)!;
      return { ...room, role: membership.role, memberCount: this.activeMembers(room.id).length, chips: this.currentChips(room.id, playerId) };
    });
  }

  historyFor(playerId: string) {
    return this.settlements.filter((settlement) => settlement.playerId === playerId).map((settlement) => ({ ...settlement, room: this.rooms.get(settlement.roomId) }));
  }

  setInvite(hostId: string, roomId: string, open: boolean): Room {
    const room = this.requireHost(roomId, hostId); room.inviteOpen = open; return room;
  }

  credit(hostId: string, roomId: string, playerId: string, amount: number, idempotencyKey: string): LedgerEntry {
    const room = this.requireHost(roomId, hostId);
    this.requireMember(room.id, playerId, true);
    if (!idempotencyKey) throw new Error('缺少幂等键');
    const previous = this.ledger.find((entry) => entry.idempotencyKey === idempotencyKey);
    if (previous) return previous;
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('补充积分必须为正整数');
    const entry = this.addLedger(roomId, playerId, hostId, amount, 'topup', idempotencyKey);
    this.tables.get(roomId)?.topUp(playerId, amount);
    return entry;
  }

  ledgerFor(roomId: string, viewerId: string): LedgerEntry[] {
    this.requireMember(roomId, viewerId, false);
    const host = this.room(roomId).hostId === viewerId;
    return this.ledger.filter((entry) => entry.roomId === roomId && (host || entry.playerId === viewerId));
  }

  dissolve(hostId: string, roomId: string): Room {
    const room = this.requireHost(roomId, hostId);
    room.inviteOpen = false;
    const table = this.tables.get(roomId);
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
    if (room.status !== 'active') throw new Error('牌局正在关闭或已解散');
    let table = this.tables.get(roomId);
    if (!table) { table = new PokerTable(roomId, room.smallBlind, room.bigBlind, room.maxSeats); this.tables.set(roomId, table); }
    const player = this.players.get(playerId)!;
    table.addPlayer({ id: player.id, nickname: player.nickname, stack: this.balance(roomId, playerId) });
    return table;
  }

  startTable(hostId: string, roomId: string): PokerTable {
    this.requireHost(roomId, hostId);
    const table = this.tables.get(roomId);
    if (!table) throw new Error('请先进入牌桌');
    table.startNextHand();
    if (table.snapshot(hostId).hand?.status !== 'active') throw new Error('至少需要两位拥有积分的玩家入桌');
    return table;
  }

  maybeFinalize(roomId: string): void {
    const room = this.rooms.get(roomId);
    const host = room && room.hostId;
    if (room?.status === 'closing' && host && this.tables.get(roomId)?.snapshot(host).hand?.status === 'settled') this.finalizeDissolve(roomId);
  }

  private addLedger(roomId: string, playerId: string, actorId: string, amount: number, reason: LedgerEntry['reason'], idempotencyKey: string): LedgerEntry {
    const entry = { id: randomUUID(), roomId, playerId, actorId, amount, reason, idempotencyKey, createdAt: now() };
    this.ledger.push(entry); return entry;
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
