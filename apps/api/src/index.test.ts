import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from './index.js';

const servers: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); });

describe('HTTP API', () => {
  it('accepts an invite join request with an empty JSON body', async () => {
    const { app } = await buildServer(); servers.push(app);
    const hostResponse = await app.inject({ method: 'POST', url: '/api/guests', payload: { nickname: 'Host' } });
    const hostCookie = hostResponse.headers['set-cookie'] as string;
    const created = await app.inject({ method: 'POST', url: '/api/rooms', headers: { cookie: hostCookie }, payload: { name: 'Private', maxSeats: 6, smallBlind: 20, initialChips: 1500 } });
    const room = created.json().room as { inviteCode: string };
    const guestResponse = await app.inject({ method: 'POST', url: '/api/guests', payload: { nickname: 'Guest' } });
    const guestCookie = guestResponse.headers['set-cookie'] as string;

    const joined = await app.inject({ method: 'POST', url: `/api/invites/${room.inviteCode}/join`, headers: { cookie: guestCookie, 'content-type': 'application/json' } });

    expect(joined.statusCode).toBe(200);
  });

  it('creates a guest cookie, creates a room, and enforces host-only credits', async () => {
    const { app } = await buildServer(); servers.push(app);
    const hostResponse = await app.inject({ method: 'POST', url: '/api/guests', payload: { nickname: 'Host' } });
    expect(hostResponse.statusCode).toBe(200);
    const hostCookie = hostResponse.headers['set-cookie'] as string;
    const created = await app.inject({ method: 'POST', url: '/api/rooms', headers: { cookie: hostCookie }, payload: { name: 'Private', maxSeats: 6, smallBlind: 20, initialChips: 1500 } });
    expect(created.statusCode).toBe(200);
    const room = created.json().room as { id: string; inviteCode: string };
    const guestResponse = await app.inject({ method: 'POST', url: '/api/guests', payload: { nickname: 'Guest' } });
    const guestCookie = guestResponse.headers['set-cookie'] as string;
    expect((await app.inject({ method: 'POST', url: `/api/invites/${room.inviteCode}/join`, headers: { cookie: guestCookie } })).statusCode).toBe(200);
    const forbidden = await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/credits`, headers: { cookie: guestCookie, 'idempotency-key': 'guest-credit' }, payload: { playerId: guestResponse.json().player.id, amount: 500 } });
    expect(forbidden.statusCode).toBe(400);
    expect(forbidden.json().error).toContain('仅房主');
  });

  it('rotates invite credentials and rate-limits repeated invalid join attempts', async () => {
    const { app } = await buildServer(); servers.push(app);
    const hostResponse = await app.inject({ method: 'POST', url: '/api/guests', payload: { nickname: 'Host' } });
    const hostCookie = hostResponse.headers['set-cookie'] as string;
    const created = await app.inject({ method: 'POST', url: '/api/rooms', headers: { cookie: hostCookie }, payload: { name: 'Private', maxSeats: 6, smallBlind: 20, initialChips: 1500 } });
    const original = created.json().room as { id: string; inviteCode: string };
    const rotatedResponse = await app.inject({ method: 'POST', url: `/api/rooms/${original.id}/invite/rotate`, headers: { cookie: hostCookie } });
    expect(rotatedResponse.statusCode).toBe(200);
    const rotated = rotatedResponse.json().room as { inviteCode: string };
    expect(rotated.inviteCode).not.toBe(original.inviteCode);

    const guestResponse = await app.inject({ method: 'POST', url: '/api/guests', payload: { nickname: 'Guest' } });
    const guestCookie = guestResponse.headers['set-cookie'] as string;
    expect((await app.inject({ method: 'POST', url: `/api/invites/${original.inviteCode}/join`, headers: { cookie: guestCookie } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/invites/${rotated.inviteCode}/join`, headers: { cookie: guestCookie } })).statusCode).toBe(200);

    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await app.inject({ method: 'POST', url: `/api/invites/INVALID-${attempt}/join`, headers: { cookie: guestCookie } });
      expect(response.statusCode).toBe(400);
    }
    const limited = await app.inject({ method: 'POST', url: '/api/invites/INVALID-LAST/join', headers: { cookie: guestCookie } });
    expect(limited.statusCode).toBe(429);
  });

  it('keeps failed invite attempts across a successful join and allows joining while paused', async () => {
    const { app } = await buildServer(); servers.push(app);
    const hostResponse = await app.inject({ method: 'POST', url: '/api/guests', payload: { nickname: 'Host' } });
    const hostCookie = hostResponse.headers['set-cookie'] as string;
    const created = await app.inject({ method: 'POST', url: '/api/rooms', headers: { cookie: hostCookie }, payload: { name: 'Paused invite', maxSeats: 6, smallBlind: 20, initialChips: 1500 } });
    const room = created.json().room as { id: string; inviteCode: string };
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/pause`, headers: { cookie: hostCookie } });
    const guestResponse = await app.inject({ method: 'POST', url: '/api/guests', payload: { nickname: 'Guest' } });
    const guestCookie = guestResponse.headers['set-cookie'] as string;

    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await app.inject({ method: 'POST', url: `/api/invites/BAD-BEFORE-${attempt}/join`, headers: { cookie: guestCookie } })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: 'POST', url: `/api/invites/${room.inviteCode}/join`, headers: { cookie: guestCookie } })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await app.inject({ method: 'POST', url: `/api/invites/BAD-AFTER-${attempt}/join`, headers: { cookie: guestCookie } })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: 'POST', url: '/api/invites/BAD-LIMIT/join', headers: { cookie: guestCookie } })).statusCode).toBe(429);
  });

  it('returns an authenticated viewer projection over HTTP with version reconciliation', async () => {
    const { app, store } = await buildServer(); servers.push(app);
    const hostResponse = await app.inject({ method: 'POST', url: '/api/guests', payload: { nickname: 'Host' } });
    const hostCookie = hostResponse.headers['set-cookie'] as string;
    const hostId = hostResponse.json().player.id as string;
    const created = await app.inject({ method: 'POST', url: '/api/rooms', headers: { cookie: hostCookie }, payload: { name: 'Snapshot', maxSeats: 6, smallBlind: 10, initialChips: 500 } });
    const room = created.json().room as { id: string };
    store.tableFor(room.id, hostId);

    const first = await app.inject({ method: 'GET', url: `/api/rooms/${room.id}/table`, headers: { cookie: hostCookie } });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ snapshot: { roomId: room.id, players: [expect.objectContaining({ id: hostId })] }, unchanged: false });
    const version = first.json().snapshot.sequence as number;
    const reconciled = await app.inject({ method: 'GET', url: `/api/rooms/${room.id}/table?version=${version}`, headers: { cookie: hostCookie } });
    expect(reconciled.json().unchanged).toBe(true);

    const outsiderResponse = await app.inject({ method: 'POST', url: '/api/guests', payload: { nickname: 'Outsider' } });
    expect((await app.inject({ method: 'GET', url: `/api/rooms/${room.id}/table`, headers: { cookie: outsiderResponse.headers['set-cookie'] as string } })).statusCode).toBe(400);
  });

  it('exposes host lifecycle controls and member sit-in or sit-out commands', async () => {
    const { app, store } = await buildServer(); servers.push(app);
    const hostResponse = await app.inject({ method: 'POST', url: '/api/guests', payload: { nickname: 'Host' } });
    const hostCookie = hostResponse.headers['set-cookie'] as string;
    const hostId = hostResponse.json().player.id as string;
    const created = await app.inject({ method: 'POST', url: '/api/rooms', headers: { cookie: hostCookie }, payload: { name: 'Controls', maxSeats: 6, smallBlind: 10, initialChips: 500 } });
    const room = created.json().room as { id: string; inviteCode: string };
    const guestResponse = await app.inject({ method: 'POST', url: '/api/guests', payload: { nickname: 'Guest' } });
    const guestCookie = guestResponse.headers['set-cookie'] as string;
    const guestId = guestResponse.json().player.id as string;
    await app.inject({ method: 'POST', url: `/api/invites/${room.inviteCode}/join`, headers: { cookie: guestCookie } });
    store.credit(hostId, room.id, guestId, 500, 'controls-guest-credit');
    store.tableFor(room.id, hostId);
    const table = store.tableFor(room.id, guestId);

    const forbiddenPause = await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/pause`, headers: { cookie: guestCookie } });
    expect(forbiddenPause.statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/pause`, headers: { cookie: hostCookie } })).statusCode).toBe(200);
    expect(store.rooms.get(room.id)?.status).toBe('paused');
    expect((await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/resume`, headers: { cookie: hostCookie } })).statusCode).toBe(200);

    expect((await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/sit-out`, headers: { cookie: guestCookie } })).statusCode).toBe(200);
    expect(table.players.find((player) => player.id === guestId)?.participation).toBe('sitting-out');
    expect((await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/sit-in`, headers: { cookie: guestCookie } })).statusCode).toBe(200);
    expect(table.players.find((player) => player.id === guestId)?.participation).toBe('seated');
  });

  it('rejects every host-only room mutation from an invited player without changing room state', async () => {
    const { app, store } = await buildServer(); servers.push(app);
    const hostResponse = await app.inject({ method: 'POST', url: '/api/guests', payload: { nickname: 'Host' } });
    const hostCookie = hostResponse.headers['set-cookie'] as string;
    const hostId = hostResponse.json().player.id as string;
    const created = await app.inject({ method: 'POST', url: '/api/rooms', headers: { cookie: hostCookie }, payload: { name: 'Authorization', maxSeats: 6, smallBlind: 10, initialChips: 500 } });
    const room = created.json().room as { id: string; inviteCode: string };
    const guestResponse = await app.inject({ method: 'POST', url: '/api/guests', payload: { nickname: 'Guest' } });
    const guestCookie = guestResponse.headers['set-cookie'] as string;
    const guestId = guestResponse.json().player.id as string;
    await app.inject({ method: 'POST', url: `/api/invites/${room.inviteCode}/join`, headers: { cookie: guestCookie } });

    const attempts = [
      app.inject({ method: 'PATCH', url: `/api/rooms/${room.id}/invite`, headers: { cookie: guestCookie }, payload: { open: false } }),
      app.inject({ method: 'POST', url: `/api/rooms/${room.id}/invite/rotate`, headers: { cookie: guestCookie } }),
      app.inject({ method: 'POST', url: `/api/rooms/${room.id}/members/${hostId}/remove`, headers: { cookie: guestCookie } }),
      app.inject({ method: 'POST', url: `/api/rooms/${room.id}/dissolve`, headers: { cookie: guestCookie } })
    ];

    for (const response of await Promise.all(attempts)) {
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain('仅房主');
    }
    expect(store.rooms.get(room.id)).toMatchObject({ status: 'active', inviteOpen: true, inviteCode: room.inviteCode });
    expect(store.memberships.get(`${room.id}:${guestId}`)?.status).toBe('active');
  });
});
