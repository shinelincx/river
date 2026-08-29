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
});
