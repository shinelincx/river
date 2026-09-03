export type TableJoinResponse = { ok: boolean; error?: string };

export type TableSessionSocket = {
  connected: boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  emit(event: string, ...args: unknown[]): unknown;
};

export type TableSession = {
  recover(): void;
  dispose(): void;
  acceptSnapshot(snapshot: TableSnapshot): 'accepted' | 'stale' | 'conflict';
  isSynchronized(): boolean;
};

export type TableSnapshot = { sequence: number; timing?: { serverNow?: number; [key: string]: unknown }; [key: string]: unknown };

type TableSessionOptions = {
  socket: TableSessionSocket;
  roomId: string;
  refreshSnapshot: () => Promise<void>;
  onJoinError?: (message: string) => void;
  retryDelayMs?: number;
  joinTimeoutMs?: number;
  syncIntervalMs?: number;
};

export function bindTableSession({
  socket,
  roomId,
  refreshSnapshot,
  onJoinError,
  retryDelayMs = 1_000,
  joinTimeoutMs = 5_000,
  syncIntervalMs = 5_000
}: TableSessionOptions): TableSession {
  let stopped = false;
  let joined = false;
  let joining = false;
  let generation = 0;
  let joinTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let syncTimer: ReturnType<typeof setTimeout> | undefined;
  let currentSnapshot: TableSnapshot | undefined;
  let synchronized = true;

  const authorityShape = (snapshot: TableSnapshot) => {
    const { timing, ...rest } = snapshot;
    const { serverNow: _serverNow, ...authorityTiming } = timing ?? {};
    return JSON.stringify({ ...rest, timing: authorityTiming });
  };

  const clearTimer = (timer: ReturnType<typeof setTimeout> | undefined) => {
    if (timer !== undefined) clearTimeout(timer);
  };
  const clearPending = () => {
    clearTimer(joinTimer);
    clearTimer(retryTimer);
    clearTimer(syncTimer);
    joinTimer = undefined;
    retryTimer = undefined;
    syncTimer = undefined;
  };
  const refresh = () => { void refreshSnapshot().catch(() => undefined); };
  const scheduleSync = () => {
    clearTimer(syncTimer);
    if (stopped || !joined || !socket.connected) return;
    syncTimer = setTimeout(() => {
      syncTimer = undefined;
      if (stopped || !joined || !socket.connected) return;
      socket.emit('table:sync');
      refresh();
      scheduleSync();
    }, syncIntervalMs);
  };
  const scheduleJoin = (join: () => void) => {
    clearTimer(retryTimer);
    if (stopped || !socket.connected) return;
    retryTimer = setTimeout(join, retryDelayMs);
  };

  const join = () => {
    if (stopped || joining || !socket.connected) return;
    joining = true;
    joined = false;
    const currentGeneration = ++generation;
    clearTimer(joinTimer);
    joinTimer = setTimeout(() => {
      if (stopped || currentGeneration !== generation) return;
      joining = false;
      joinTimer = undefined;
      scheduleJoin(join);
    }, joinTimeoutMs);
    socket.emit('table:join', { roomId }, (response: TableJoinResponse) => {
      if (stopped || currentGeneration !== generation) return;
      clearTimer(joinTimer);
      joinTimer = undefined;
      joining = false;
      if (!response?.ok) {
        joined = false;
        onJoinError?.(response?.error ?? '无法进入牌桌');
        scheduleJoin(join);
        return;
      }
      joined = true;
      refresh();
      scheduleSync();
    });
  };

  const handleConnect = () => join();
  const handleDisconnect = () => {
    generation++;
    joined = false;
    joining = false;
    clearPending();
  };
  socket.on('connect', handleConnect);
  socket.on('disconnect', handleDisconnect);
  if (socket.connected) join();

  return {
    recover() {
      if (stopped) return;
      generation++;
      joined = false;
      joining = false;
      clearPending();
      join();
    },
    dispose() {
      if (stopped) return;
      stopped = true;
      generation++;
      clearPending();
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
    },
    acceptSnapshot(snapshot) {
      if (currentSnapshot && snapshot.sequence < currentSnapshot.sequence) return 'stale';
      if (currentSnapshot && snapshot.sequence === currentSnapshot.sequence && authorityShape(snapshot) !== authorityShape(currentSnapshot)) {
        synchronized = false;
        this.recover();
        return 'conflict';
      }
      currentSnapshot = snapshot;
      synchronized = true;
      return 'accepted';
    },
    isSynchronized() {
      return synchronized;
    }
  };
}
