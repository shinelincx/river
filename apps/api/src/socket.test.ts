import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { io } from 'socket.io-client';
import { buildServer } from './index.js';
import type { PostgresTableRepository } from './persistence.js';
import { RiverStore } from './store.js';

type ClientSocket = ReturnType<typeof io>;
type TableSnapshot = {
  sequence: number;
  players: Array<{ id: string; hole?: unknown[] }>;
  preparing?: { id: string; participantIds: string[] };
  hand?: { id: string; status: string; currentPlayerId?: string };
  timing?: { actionDeadlineAt?: number };
};

const servers: FastifyInstance[] = [];
const sockets: ClientSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.disconnect();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function connect(baseUrl: string, cookie?: string): Promise<ClientSocket> {
  const socket = io(baseUrl, { transports: ['websocket'], extraHeaders: cookie ? { cookie } : undefined });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  return socket;
}

function acknowledge(socket: ClientSocket, event: string, payload?: unknown): Promise<{ ok: boolean; error?: string; sequence?: number }> {
  return new Promise((resolve) => {
    if (payload === undefined) socket.emit(event, (response: { ok: boolean; error?: string }) => resolve(response));
    else socket.emit(event, payload, (response: { ok: boolean; error?: string }) => resolve(response));
  });
}

function nextSnapshot(socket: ClientSocket): Promise<TableSnapshot> {
  return new Promise((resolve) => socket.once('table:snapshot', resolve));
}

function nextSnapshotWhere(socket: ClientSocket, predicate: (snapshot: TableSnapshot) => boolean): Promise<TableSnapshot> {
  return new Promise((resolve) => {
    const listener = (snapshot: TableSnapshot) => {
      if (!predicate(snapshot)) return;
      socket.off('table:snapshot', listener);
      resolve(snapshot);
    };
    socket.on('table:snapshot', listener);
  });
}

async function startWithContributions(hostSocket: ClientSocket, guestSocket: ClientSocket): Promise<[TableSnapshot, TableSnapshot]> {
  const hostPreparing = nextSnapshot(hostSocket);
  const guestPreparing = nextSnapshot(guestSocket);
  expect(await acknowledge(hostSocket, 'table:start')).toEqual({ ok: true });
  const [hostPreparation, guestPreparation] = await Promise.all([hostPreparing, guestPreparing]);
  const handId = hostPreparation.preparing!.id;
  expect(guestPreparation.preparing?.id).toBe(handId);
  expect(await acknowledge(hostSocket, 'shuffle:contribute', { handId, contribution: 'host-socket-entropy-0001' })).toEqual({ ok: true });
  const hostActive = nextSnapshotWhere(hostSocket, (snapshot) => snapshot.hand?.status === 'active');
  const guestActive = nextSnapshotWhere(guestSocket, (snapshot) => snapshot.hand?.status === 'active');
  expect(await acknowledge(guestSocket, 'shuffle:contribute', { handId, contribution: 'guest-socket-entropy-0001' })).toEqual({ ok: true });
  return Promise.all([hostActive, guestActive]);
}

describe('Socket table API', () => {
  it('authenticates the Cookie session and sends each player a private table snapshot', async () => {
    const { app } = await buildServer();
    servers.push(app);
    const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });

    const hostResponse = await app.inject({ method: 'POST', url: '/api/guests', payload: { nickname: 'Host' } });
    const hostCookie = hostResponse.headers['set-cookie'] as string;
    const host = hostResponse.json().player as { id: string };
    const roomResponse = await app.inject({ method: 'POST', url: '/api/rooms', headers: { cookie: hostCookie }, payload: { name: 'Socket room', maxSeats: 6, smallBlind: 10, initialChips: 500 } });
    const room = roomResponse.json().room as { id: string; inviteCode: string };
    const guestResponse = await app.inject({ method: 'POST', url: '/api/guests', payload: { nickname: 'Guest' } });
    const guestCookie = guestResponse.headers['set-cookie'] as string;
    const guest = guestResponse.json().player as { id: string };
    await app.inject({ method: 'POST', url: `/api/invites/${room.inviteCode}/join`, headers: { cookie: guestCookie } });
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/credits`, headers: { cookie: hostCookie, 'idempotency-key': 'socket-guest-credit' }, payload: { playerId: guest.id, amount: 500 } });
    const waitingResponse = await app.inject({ method: 'POST', url: '/api/guests', payload: { nickname: 'Waiting' } });
    const waitingCookie = waitingResponse.headers['set-cookie'] as string;
    const waiting = waitingResponse.json().player as { id: string };
    await app.inject({ method: 'POST', url: `/api/invites/${room.inviteCode}/join`, headers: { cookie: waitingCookie } });
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/credits`, headers: { cookie: hostCookie, 'idempotency-key': 'socket-waiting-credit' }, payload: { playerId: waiting.id, amount: 500 } });

    const hostSocket = await connect(baseUrl, hostCookie);
    const guestSocket = await connect(baseUrl, guestCookie);
    expect(await acknowledge(hostSocket, 'table:join', { roomId: room.id })).toEqual({ ok: true });
    expect(await acknowledge(guestSocket, 'table:join', { roomId: room.id })).toEqual({ ok: true });

    const [hostView, guestView] = await startWithContributions(hostSocket, guestSocket);

    expect(hostView.hand?.status).toBe('active');
    expect(hostView.players.find((player) => player.id === host.id)?.hole).toHaveLength(2);
    expect(hostView.players.find((player) => player.id === guest.id)?.hole).toBeUndefined();
    expect(guestView.players.find((player) => player.id === guest.id)?.hole).toHaveLength(2);
    expect(guestView.players.find((player) => player.id === host.id)?.hole).toBeUndefined();

    const waitingSocket = await connect(baseUrl, waitingCookie);
    const hostAfterWaitingJoin = nextSnapshotWhere(hostSocket, (snapshot) => snapshot.players.some((item) => item.id === waiting.id));
    expect(await acknowledge(waitingSocket, 'table:join', { roomId: room.id })).toEqual({ ok: true });
    const beforeFold = await hostAfterWaitingJoin;
    const settledEvent = new Promise<Record<string, unknown>>((resolve) => {
      const listener = (event: { type?: string }) => {
        if (event.type !== 'hand_settled') return;
        waitingSocket.off('hand:event', listener);
        resolve(event as Record<string, unknown>);
      };
      waitingSocket.on('hand:event', listener);
    });
    const actorSocket = beforeFold.hand!.currentPlayerId === host.id ? hostSocket : guestSocket;
    expect(await acknowledge(actorSocket, 'action:submit', {
      actionId: 'privacy-fold', handId: beforeFold.hand!.id, version: beforeFold.sequence, type: 'fold'
    })).toMatchObject({ ok: true });
    const event = await settledEvent;
    const auditResponse = await app.inject({ method: 'GET', url: `/api/rooms/${room.id}/hands/${beforeFold.hand!.id}/audit`, headers: { cookie: hostCookie } });
    const serverSeed = auditResponse.json().audit.serverSeed as string;
    expect(JSON.stringify(event)).not.toContain(serverSeed);

    const revoked = new Promise<void>((resolve) => waitingSocket.once('table:revoked', () => resolve()));
    const removal = await app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/members/${waiting.id}/remove`,
      headers: { cookie: hostCookie }
    });
    expect(removal.statusCode).toBe(200);
    await revoked;
    expect(await acknowledge(waitingSocket, 'table:start')).toMatchObject({ ok: false, error: '尚未进入牌桌' });
    let receivedAfterRevocation = false;
    waitingSocket.once('table:snapshot', () => { receivedAfterRevocation = true; });
    waitingSocket.emit('table:sync');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(receivedAfterRevocation).toBe(false);
    expect(JSON.stringify(event)).not.toMatch(/serverSeed|"seed"|holeCards|playerContributions/);
  });

  it('validates action commands and handles a repeated actionId exactly once', async () => {
    const { app, store } = await buildServer();
    servers.push(app);
    const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    const hostResponse = await app.inject({ method: 'POST', url: '/api/guests', payload: { nickname: 'Host' } });
    const hostCookie = hostResponse.headers['set-cookie'] as string;
    const host = hostResponse.json().player as { id: string };
    const roomResponse = await app.inject({ method: 'POST', url: '/api/rooms', headers: { cookie: hostCookie }, payload: { name: 'Action room', maxSeats: 6, smallBlind: 10, initialChips: 500 } });
    const room = roomResponse.json().room as { id: string; inviteCode: string };
    const guestResponse = await app.inject({ method: 'POST', url: '/api/guests', payload: { nickname: 'Guest' } });
    const guestCookie = guestResponse.headers['set-cookie'] as string;
    const guest = guestResponse.json().player as { id: string };
    await app.inject({ method: 'POST', url: `/api/invites/${room.inviteCode}/join`, headers: { cookie: guestCookie } });
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/credits`, headers: { cookie: hostCookie, 'idempotency-key': 'action-guest-credit' }, payload: { playerId: guest.id, amount: 500 } });
    const hostSocket = await connect(baseUrl, hostCookie);
    const guestSocket = await connect(baseUrl, guestCookie);
    await acknowledge(hostSocket, 'table:join', { roomId: room.id });
    await acknowledge(guestSocket, 'table:join', { roomId: room.id });
    const [before] = await startWithContributions(hostSocket, guestSocket);

    const invalid = await acknowledge(hostSocket, 'action:submit', {
      actionId: 'invalid-action', handId: before.hand!.id, version: before.sequence, type: 'dance'
    });
    expect(invalid).toMatchObject({ ok: false, error: '动作类型无效' });

    const stale = await acknowledge(hostSocket, 'action:submit', {
      actionId: 'stale-action', handId: before.hand!.id, version: before.sequence - 1, type: 'call'
    });
    expect(stale).toMatchObject({ ok: false, error: '牌桌状态已变化，请同步后重试' });

    const command = { actionId: 'call-once', handId: before.hand!.id, version: before.sequence, type: 'call' };
    const [first, duplicate] = await Promise.all([
      acknowledge(hostSocket, 'action:submit', command),
      acknowledge(hostSocket, 'action:submit', command)
    ]);

    expect(first).toMatchObject({ ok: true, sequence: expect.any(Number) });
    expect(duplicate).toEqual(first);
    expect(store.tables.get(room.id)!.recentEvents.filter((event) => event.type === 'action' && event.payload.playerId === host.id)).toHaveLength(1);

    const afterAcceptedPending = nextSnapshot(hostSocket);
    hostSocket.emit('table:sync');
    const afterAccepted = await afterAcceptedPending;
    const duplicateAgain = await acknowledge(hostSocket, 'action:submit', command);
    const afterDuplicatePending = nextSnapshot(hostSocket);
    hostSocket.emit('table:sync');
    const afterDuplicate = await afterDuplicatePending;
    expect(duplicateAgain).toEqual(first);
    expect(afterDuplicate.timing?.actionDeadlineAt).toBe(afterAccepted.timing?.actionDeadlineAt);

    const secondHostTab = await connect(baseUrl, hostCookie);
    await acknowledge(secondHostTab, 'table:join', { roomId: room.id });
    secondHostTab.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.tables.get(room.id)?.players.find((player) => player.id === host.id)?.connected).toBe(true);
  });

  it('rolls an accepted action back when authoritative persistence fails', async () => {
    const store = new RiverStore();
    const { player: host, sessionId: hostSession } = store.createGuest('Host');
    const { player: guest, sessionId: guestSession } = store.createGuest('Guest');
    const room = store.createRoom(host.id, { name: 'Rollback room', maxSeats: 6, smallBlind: 10, initialChips: 500 });
    store.joinByCode(guest.id, room.inviteCode);
    store.credit(host.id, room.id, guest.id, 500, 'rollback-guest-credit');
    store.tableFor(room.id, host.id);
    store.tableFor(room.id, guest.id);
    let failWrites = false;
    const persistence = {
      loadTable: async () => undefined,
      purgeExpiredAudits: async () => 0,
      saveStore: async () => { if (failWrites) throw new Error('simulated persistence failure'); },
      close: async () => undefined
    } as unknown as PostgresTableRepository;
    const { app } = await buildServer(store, persistence);
    servers.push(app);
    const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    const hostSocket = await connect(baseUrl, `river_session=${hostSession}`);
    const guestSocket = await connect(baseUrl, `river_session=${guestSession}`);
    await acknowledge(hostSocket, 'table:join', { roomId: room.id });
    await acknowledge(guestSocket, 'table:join', { roomId: room.id });
    const [before] = await startWithContributions(hostSocket, guestSocket);
    failWrites = true;

    const actorSocket = before.hand!.currentPlayerId === host.id ? hostSocket : guestSocket;
    const response = await acknowledge(actorSocket, 'action:submit', {
      actionId: 'must-roll-back', handId: before.hand!.id, version: before.sequence, type: 'call'
    });
    const restoredPending = nextSnapshot(actorSocket);
    actorSocket.emit('table:sync');
    const restored = await restoredPending;

    expect(response).toMatchObject({ ok: false, error: 'simulated persistence failure' });
    expect({ ...restored, timing: undefined }).toEqual({ ...before, timing: undefined });
  });
});
