import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { io } from 'socket.io-client';
import { buildServer } from './index.js';

type ClientSocket = ReturnType<typeof io>;
type TableSnapshot = { players: Array<{ id: string; hole?: unknown[] }>; hand?: { status: string } };

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

function acknowledge(socket: ClientSocket, event: string, payload?: unknown): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    if (payload === undefined) socket.emit(event, (response: { ok: boolean; error?: string }) => resolve(response));
    else socket.emit(event, payload, (response: { ok: boolean; error?: string }) => resolve(response));
  });
}

function nextSnapshot(socket: ClientSocket): Promise<TableSnapshot> {
  return new Promise((resolve) => socket.once('table:snapshot', resolve));
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

    const hostSocket = await connect(baseUrl, hostCookie);
    const guestSocket = await connect(baseUrl, guestCookie);
    expect(await acknowledge(hostSocket, 'table:join', { roomId: room.id })).toEqual({ ok: true });
    expect(await acknowledge(guestSocket, 'table:join', { roomId: room.id })).toEqual({ ok: true });

    const hostSnapshot = nextSnapshot(hostSocket);
    const guestSnapshot = nextSnapshot(guestSocket);
    expect(await acknowledge(hostSocket, 'table:start')).toEqual({ ok: true });
    const [hostView, guestView] = await Promise.all([hostSnapshot, guestSnapshot]);

    expect(hostView.hand?.status).toBe('active');
    expect(hostView.players.find((player) => player.id === host.id)?.hole).toHaveLength(2);
    expect(hostView.players.find((player) => player.id === guest.id)?.hole).toBeUndefined();
    expect(guestView.players.find((player) => player.id === guest.id)?.hole).toHaveLength(2);
    expect(guestView.players.find((player) => player.id === host.id)?.hole).toBeUndefined();
  });
});
