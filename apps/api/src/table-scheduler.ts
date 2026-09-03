import type { RiverStore } from './store.js';

type Broadcast = (roomId: string) => Promise<void>;
type Persist = (roomId: string) => Promise<void>;
type Exclusive = <T>(roomId: string, work: () => Promise<T>) => Promise<T>;
export type PersistedTableTiming = {
  actionDeadlineAt?: number;
  nextHandStartsAt?: number;
  reconnectDeadlines: Record<string, number>;
};

export class TableScheduler {
  private readonly timeoutTimers = new Map<string, NodeJS.Timeout>();
  private readonly actionDeadlines = new Map<string, number>();
  private readonly nextHandTimers = new Map<string, NodeJS.Timeout>();
  private readonly nextHandStarts = new Map<string, number>();
  private readonly disconnectTimers = new Map<string, NodeJS.Timeout>();
  private readonly reconnectDeadlines = new Map<string, number>();

  constructor(
    private readonly store: RiverStore,
    private readonly broadcast: Broadcast,
    private readonly actionTimeoutMs = 20_000,
    private readonly nextHandDelayMs = 5_000,
    private readonly reconnectGraceMs = 60_000,
    private readonly persist: Persist = async () => undefined,
    private readonly exclusive: Exclusive = async (_roomId, work) => work()
  ) {}

  snapshot(roomId: string, viewerId: string) {
    const table = this.store.tables.get(roomId);
    if (!table) throw new Error('牌桌不存在');
    const snapshot = table.snapshot(viewerId);
    return {
      ...snapshot,
      timing: {
        serverNow: Date.now(),
        actionDeadlineAt: this.actionDeadlines.get(roomId),
        nextHandStartsAt: this.nextHandStarts.get(roomId),
        reconnectDeadlines: Object.fromEntries(
          [...this.reconnectDeadlines.entries()]
            .filter(([key]) => key.startsWith(`${roomId}:`))
            .map(([key, deadline]) => [key.slice(roomId.length + 1), deadline])
        ),
        waitingForReconnect: table.hasDisconnectedSeatedPlayers(),
        waitingForPlayers: this.store.rooms.get(roomId)?.status === 'active'
          && snapshot.hand?.status === 'settled'
          && !table.canStartHand()
      }
    };
  }

  async join(roomId: string): Promise<void> {
    this.scheduleTimeout(roomId, false);
    this.scheduleNextHand(roomId);
    await this.persist(roomId);
    await this.safeBroadcast(roomId);
  }

  async stateChanged(roomId: string): Promise<void> {
    this.scheduleTimeout(roomId, true);
    this.scheduleNextHand(roomId);
    await this.persist(roomId);
    await this.safeBroadcast(roomId);
  }

  async fundingChanged(roomId: string): Promise<void> {
    this.scheduleTimeout(roomId, false);
    this.scheduleNextHand(roomId);
    await this.persist(roomId);
    await this.safeBroadcast(roomId);
  }

  exportTiming(roomId: string): PersistedTableTiming {
    return {
      actionDeadlineAt: this.actionDeadlines.get(roomId),
      nextHandStartsAt: this.nextHandStarts.get(roomId),
      reconnectDeadlines: Object.fromEntries(
        [...this.reconnectDeadlines.entries()]
          .filter(([key]) => key.startsWith(`${roomId}:`))
          .map(([key, deadline]) => [key.slice(roomId.length + 1), deadline])
      )
    };
  }

  restoreTiming(roomId: string, timing: Partial<PersistedTableTiming>): void {
    this.clearRoomTimers(roomId);
    this.restoreActionDeadline(roomId, timing.actionDeadlineAt);
    for (const [playerId, deadlineAt] of Object.entries(timing.reconnectDeadlines ?? {})) {
      this.scheduleReconnect(roomId, playerId, deadlineAt);
    }
    const table = this.store.tables.get(roomId);
    for (const player of table?.players ?? []) {
      if (!player.connected && player.stack > 0 && player.seat > 0 && player.participation !== 'sitting-out'
        && !(player.id in (timing.reconnectDeadlines ?? {}))) {
        this.scheduleReconnect(roomId, player.id, Date.now() + this.reconnectGraceMs);
      }
    }
    this.scheduleNextHand(roomId, timing.nextHandStartsAt);
  }

  restoreActionDeadline(roomId: string, deadlineAt: number | undefined): void {
    if (deadlineAt === undefined) {
      this.scheduleTimeout(roomId, true);
      return;
    }
    this.scheduleTimeout(roomId, true, deadlineAt);
  }

  async presenceChanged(roomId: string, playerId: string, connected: boolean): Promise<void> {
    const table = this.store.tables.get(roomId);
    if (!table) throw new Error('牌桌不存在');
    table.setConnected(playerId, connected);
    const key = `${roomId}:${playerId}`;
    const existing = this.disconnectTimers.get(key);
    if (connected) {
      if (existing) clearTimeout(existing);
      this.disconnectTimers.delete(key);
      this.reconnectDeadlines.delete(key);
    } else if (!existing) {
      this.scheduleReconnect(roomId, playerId, Date.now() + this.reconnectGraceMs);
    }
    this.scheduleTimeout(roomId, false);
    this.scheduleNextHand(roomId);
    await this.persist(roomId);
    await this.safeBroadcast(roomId);
  }

  close(): void {
    for (const timer of this.timeoutTimers.values()) clearTimeout(timer);
    for (const timer of this.nextHandTimers.values()) clearTimeout(timer);
    for (const timer of this.disconnectTimers.values()) clearTimeout(timer);
    this.timeoutTimers.clear();
    this.nextHandTimers.clear();
    this.disconnectTimers.clear();
    this.actionDeadlines.clear();
    this.nextHandStarts.clear();
    this.reconnectDeadlines.clear();
  }

  private clearRoomTimers(roomId: string): void {
    const actionTimer = this.timeoutTimers.get(roomId);
    if (actionTimer) clearTimeout(actionTimer);
    this.timeoutTimers.delete(roomId);
    this.actionDeadlines.delete(roomId);
    const nextTimer = this.nextHandTimers.get(roomId);
    if (nextTimer) clearTimeout(nextTimer);
    this.nextHandTimers.delete(roomId);
    this.nextHandStarts.delete(roomId);
    for (const [key, timer] of this.disconnectTimers) {
      if (!key.startsWith(`${roomId}:`)) continue;
      clearTimeout(timer);
      this.disconnectTimers.delete(key);
      this.reconnectDeadlines.delete(key);
    }
  }

  private async safeBroadcast(roomId: string): Promise<void> {
    try {
      await this.broadcast(roomId);
    } catch {
      // Persistence is the commit point; clients recover through table:sync/reconnect.
    }
  }

  private scheduleTimeout(roomId: string, reset: boolean, restoredDeadlineAt?: number): void {
    const existing = this.timeoutTimers.get(roomId);
    const table = this.store.tables.get(roomId);
    const hand = table?.snapshot('system').hand;
    if (!table || hand?.status !== 'active' || !hand.currentPlayerId) {
      if (existing) clearTimeout(existing);
      this.timeoutTimers.delete(roomId);
      this.actionDeadlines.delete(roomId);
      return;
    }
    if (existing && !reset) return;
    if (existing) clearTimeout(existing);
    const expectedPlayerId = hand.currentPlayerId;
    const deadlineAt = restoredDeadlineAt ?? Date.now() + this.actionTimeoutMs;
    const delayMs = Math.max(0, deadlineAt - Date.now());
    this.actionDeadlines.set(roomId, deadlineAt);
    const timer = setTimeout(() => {
      void this.exclusive(roomId, async () => {
        if (this.timeoutTimers.get(roomId) !== timer) return;
        this.timeoutTimers.delete(roomId);
        this.actionDeadlines.delete(roomId);
        try {
          const currentTable = this.store.tables.get(roomId);
          if (!currentTable?.timeout(expectedPlayerId)) return;
        } catch {
          // A newer action has already replaced this timer.
          return;
        }
        this.store.maybeFinalize(roomId);
        this.scheduleTimeout(roomId, true);
        this.scheduleNextHand(roomId);
        await this.persist(roomId);
        await this.safeBroadcast(roomId);
      }).catch(() => undefined);
    }, delayMs);
    this.timeoutTimers.set(roomId, timer);
  }

  private scheduleReconnect(roomId: string, playerId: string, deadlineAt: number): void {
    const key = `${roomId}:${playerId}`;
    const existing = this.disconnectTimers.get(key);
    if (existing) clearTimeout(existing);
    this.reconnectDeadlines.set(key, deadlineAt);
    const timer = setTimeout(() => {
      void this.exclusive(roomId, async () => {
        if (this.disconnectTimers.get(key) !== timer || this.reconnectDeadlines.get(key) !== deadlineAt) return;
        this.disconnectTimers.delete(key);
        this.reconnectDeadlines.delete(key);
        const table = this.store.tables.get(roomId);
        const player = table?.players.find((item) => item.id === playerId);
        if (player && !player.connected) table!.sitOutAndReleaseSeat(playerId);
        this.scheduleTimeout(roomId, false);
        this.scheduleNextHand(roomId);
        await this.persist(roomId);
        await this.safeBroadcast(roomId);
      }).catch(() => undefined);
    }, Math.max(0, deadlineAt - Date.now()));
    this.disconnectTimers.set(key, timer);
  }

  private scheduleNextHand(roomId: string, restoredDeadlineAt?: number): void {
    const table = this.store.tables.get(roomId);
    const room = this.store.rooms.get(roomId);
    const existing = this.nextHandTimers.get(roomId);
    table?.promoteWaitingPlayers();
    const snapshot = table?.snapshot('system');
    const baseReady = table && room?.status === 'active' && snapshot?.hand?.status === 'settled' && !snapshot.preparing
      && table.players.filter((player) => player.stack > 0 && player.seat > 0 && player.participation === 'seated').length >= 2;
    const otherwiseReady = baseReady && table.canStartHand();
    if (!otherwiseReady) {
      if (existing) clearTimeout(existing);
      this.nextHandTimers.delete(roomId);
      if (!baseReady) this.nextHandStarts.delete(roomId);
      else if (restoredDeadlineAt !== undefined) this.nextHandStarts.set(roomId, restoredDeadlineAt);
      return;
    }
    if (existing) return;
    const deadlineAt = restoredDeadlineAt ?? this.nextHandStarts.get(roomId) ?? Date.now() + this.nextHandDelayMs;
    this.nextHandStarts.set(roomId, deadlineAt);
    const timer = setTimeout(() => {
      void this.exclusive(roomId, async () => {
        if (this.nextHandTimers.get(roomId) !== timer || this.nextHandStarts.get(roomId) !== deadlineAt) return;
        this.nextHandTimers.delete(roomId);
        const currentTable = this.store.tables.get(roomId);
        const currentRoom = this.store.rooms.get(roomId);
        const currentHand = currentTable?.snapshot('system').hand;
        const ready = currentRoom?.status === 'active'
          && currentHand?.status === 'settled'
          && !currentTable?.snapshot('system').preparing
          && currentTable?.canStartHand();
        if (!ready || !currentTable) return;
        this.nextHandStarts.delete(roomId);
        currentTable.startNextHand();
        this.scheduleTimeout(roomId, true);
        this.scheduleNextHand(roomId);
        await this.persist(roomId);
        await this.safeBroadcast(roomId);
      }).catch(() => undefined);
    }, Math.max(0, deadlineAt - Date.now()));
    this.nextHandTimers.set(roomId, timer);
  }
}
