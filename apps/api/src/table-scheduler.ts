import type { RiverStore } from './store.js';

type Broadcast = (roomId: string) => Promise<void>;

export class TableScheduler {
  private readonly timeoutTimers = new Map<string, NodeJS.Timeout>();
  private readonly actionDeadlines = new Map<string, number>();
  private readonly nextHandTimers = new Map<string, NodeJS.Timeout>();
  private readonly nextHandStarts = new Map<string, number>();

  constructor(
    private readonly store: RiverStore,
    private readonly broadcast: Broadcast,
    private readonly actionTimeoutMs = 20_000,
    private readonly nextHandDelayMs = 2_000
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
        waitingForPlayers: this.store.rooms.get(roomId)?.status === 'active'
          && snapshot.hand?.status === 'settled'
          && !table.canStartHand()
      }
    };
  }

  async join(roomId: string): Promise<void> {
    this.scheduleTimeout(roomId, false);
    this.scheduleNextHand(roomId);
    await this.broadcast(roomId);
  }

  async stateChanged(roomId: string): Promise<void> {
    this.scheduleTimeout(roomId, true);
    this.scheduleNextHand(roomId);
    await this.broadcast(roomId);
  }

  async fundingChanged(roomId: string): Promise<void> {
    this.scheduleTimeout(roomId, false);
    this.scheduleNextHand(roomId);
    await this.broadcast(roomId);
  }

  close(): void {
    for (const timer of this.timeoutTimers.values()) clearTimeout(timer);
    for (const timer of this.nextHandTimers.values()) clearTimeout(timer);
    this.timeoutTimers.clear();
    this.nextHandTimers.clear();
    this.actionDeadlines.clear();
    this.nextHandStarts.clear();
  }

  private scheduleTimeout(roomId: string, reset: boolean): void {
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
    this.actionDeadlines.set(roomId, Date.now() + this.actionTimeoutMs);
    this.timeoutTimers.set(roomId, setTimeout(async () => {
      this.timeoutTimers.delete(roomId);
      this.actionDeadlines.delete(roomId);
      try {
        table.timeout(expectedPlayerId);
        this.store.maybeFinalize(roomId);
        this.scheduleTimeout(roomId, true);
        this.scheduleNextHand(roomId);
        await this.broadcast(roomId);
      } catch {
        // A newer action has already replaced this timer.
      }
    }, this.actionTimeoutMs));
  }

  private scheduleNextHand(roomId: string): void {
    const table = this.store.tables.get(roomId);
    const room = this.store.rooms.get(roomId);
    const existing = this.nextHandTimers.get(roomId);
    if (!table || room?.status !== 'active' || table.snapshot('system').hand?.status !== 'settled' || !table.canStartHand()) {
      if (existing) clearTimeout(existing);
      this.nextHandTimers.delete(roomId);
      this.nextHandStarts.delete(roomId);
      return;
    }
    if (existing) return;
    this.nextHandStarts.set(roomId, Date.now() + this.nextHandDelayMs);
    this.nextHandTimers.set(roomId, setTimeout(async () => {
      this.nextHandTimers.delete(roomId);
      this.nextHandStarts.delete(roomId);
      if (this.store.rooms.get(roomId)?.status !== 'active') return;
      table.startNextHand();
      this.scheduleTimeout(roomId, true);
      this.scheduleNextHand(roomId);
      await this.broadcast(roomId);
    }, this.nextHandDelayMs));
  }
}
