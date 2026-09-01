import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindTableSession, type TableSessionSocket } from './table-session';

class FakeSocket implements TableSessionSocket {
  connected = false;
  readonly emitted: Array<{ event: string; payload?: unknown }> = [];
  joinResponses: Array<{ ok: boolean; error?: string } | undefined> = [];
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void): this {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, ...args: unknown[]): this {
    const acknowledge = typeof args.at(-1) === 'function' ? args.at(-1) as (response: { ok: boolean; error?: string }) => void : undefined;
    const payload = acknowledge ? args[0] : args.length ? args[0] : undefined;
    this.emitted.push({ event, payload });
    if (event === 'table:join') {
      const response = this.joinResponses.shift();
      if (response) acknowledge?.(response);
    }
    return this;
  }

  dispatch(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

afterEach(() => vi.useRealTimers());

describe('table session recovery', () => {
  it('rejoins and refreshes the authoritative snapshot after every socket connection', async () => {
    const socket = new FakeSocket();
    socket.joinResponses.push({ ok: true }, { ok: true });
    const refreshSnapshot = vi.fn(async () => undefined);
    const session = bindTableSession({ socket, roomId: 'room-1', refreshSnapshot });

    socket.connected = true;
    socket.dispatch('connect');
    await vi.waitFor(() => expect(refreshSnapshot).toHaveBeenCalledTimes(1));

    socket.connected = false;
    socket.dispatch('disconnect');
    socket.connected = true;
    socket.dispatch('connect');
    await vi.waitFor(() => expect(refreshSnapshot).toHaveBeenCalledTimes(2));

    expect(socket.emitted.filter(({ event }) => event === 'table:join')).toEqual([
      { event: 'table:join', payload: { roomId: 'room-1' } },
      { event: 'table:join', payload: { roomId: 'room-1' } }
    ]);
    session.dispose();
  });

  it('retries an unacknowledged join and periodically syncs so a missed next-hand snapshot cannot freeze the table', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    socket.connected = true;
    socket.joinResponses.push(undefined, { ok: true });
    const refreshSnapshot = vi.fn(async () => undefined);
    const session = bindTableSession({ socket, roomId: 'room-2', refreshSnapshot, retryDelayMs: 1_000, joinTimeoutMs: 2_000, syncIntervalMs: 5_000 });

    socket.dispatch('connect');
    await vi.advanceTimersByTimeAsync(3_000);

    expect(socket.emitted.filter(({ event }) => event === 'table:join')).toHaveLength(2);
    expect(refreshSnapshot).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(socket.emitted.filter(({ event }) => event === 'table:sync')).toHaveLength(1);
    expect(refreshSnapshot).toHaveBeenCalledTimes(2);
    session.dispose();
  });

  it('forces a fresh join when an action reports that the socket lost its table membership', async () => {
    const socket = new FakeSocket();
    socket.joinResponses.push({ ok: true }, { ok: true });
    const refreshSnapshot = vi.fn(async () => undefined);
    const session = bindTableSession({ socket, roomId: 'room-3', refreshSnapshot });
    socket.connected = true;
    socket.dispatch('connect');
    await vi.waitFor(() => expect(refreshSnapshot).toHaveBeenCalledTimes(1));

    session.recover();
    await vi.waitFor(() => expect(refreshSnapshot).toHaveBeenCalledTimes(2));

    expect(socket.emitted.filter(({ event }) => event === 'table:join')).toHaveLength(2);
    session.dispose();
  });
});
