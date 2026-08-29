import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { Server } from 'socket.io';
import { RiverStore } from './store.js';
import type { Action } from './game-engine.js';
import { TableScheduler } from './table-scheduler.js';

declare module 'fastify' { interface FastifyRequest { riverPlayerId?: string } }

const SESSION_COOKIE = 'river_session';
const playerIdFromCookie = (header?: string) => header?.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`))?.[1];

function validateNickname(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 16) throw new Error('昵称需为 1–16 个字符');
  return value.trim();
}

export async function buildServer(store = new RiverStore()): Promise<{ app: FastifyInstance; io: Server; store: RiverStore }> {
  const app = Fastify({ logger: true });
  let scheduler!: TableScheduler;
  await app.register(cookie);
  await app.register(cors, { origin: [/^http:\/\/localhost:\d+$/], credentials: true });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, payload, done) => {
    const body = payload.toString();
    if (!body.trim()) return done(null, undefined);
    try { return done(null, JSON.parse(body)); }
    catch (error) { return done(error as Error, undefined); }
  });
  app.addHook('preHandler', async (request) => { request.riverPlayerId = store.playerForSession(request.cookies[SESSION_COOKIE])?.id; });
  const requirePlayer = (request: FastifyRequest) => { if (!request.riverPlayerId) throw new Error('请先创建游客身份'); return request.riverPlayerId; };
  const body = <T>(request: FastifyRequest) => request.body as T;

  app.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : '请求无效';
    const unauthorized = message === '请先创建游客身份';
    reply.status(unauthorized ? 401 : 400).send({ error: message });
  });

  app.post('/api/guests', async (request, reply) => {
    const { player, sessionId } = store.createGuest(validateNickname(body<{ nickname: string }>(request).nickname));
    reply.setCookie(SESSION_COOKIE, sessionId, { httpOnly: true, sameSite: 'lax', path: '/', secure: false, maxAge: 60 * 60 * 24 * 30 });
    return { player };
  });
  app.get('/api/me', async (request) => ({ player: store.playerForSession(request.cookies[SESSION_COOKIE]) ?? null }));
  app.get('/api/rooms', async (request) => ({ rooms: store.roomsFor(requirePlayer(request)) }));
  app.post('/api/rooms', async (request) => {
    const input = body<{ name: string; maxSeats: 6 | 9; smallBlind: number; initialChips: number }>(request);
    return { room: store.createRoom(requirePlayer(request), input) };
  });
  app.post('/api/invites/:code/join', async (request) => ({ room: store.joinByCode(requirePlayer(request), (request.params as { code: string }).code) }));
  app.get('/api/rooms/:roomId', async (request) => ({ room: store.roomView((request.params as { roomId: string }).roomId, requirePlayer(request)) }));
  app.get('/api/rooms/:roomId/ledger', async (request) => ({ entries: store.ledgerFor((request.params as { roomId: string }).roomId, requirePlayer(request)) }));
  app.patch('/api/rooms/:roomId/invite', async (request) => {
    const room = store.setInvite(requirePlayer(request), (request.params as { roomId: string }).roomId, Boolean(body<{ open: boolean }>(request).open));
    return { room };
  });
  app.post('/api/rooms/:roomId/credits', async (request) => {
    const roomId = (request.params as { roomId: string }).roomId;
    const input = body<{ playerId: string; amount: number }>(request);
    const key = request.headers['idempotency-key'];
    const entry = store.credit(requirePlayer(request), roomId, input.playerId, input.amount, typeof key === 'string' ? key : '');
    await scheduler.fundingChanged(roomId);
    return { entry };
  });
  app.post('/api/rooms/:roomId/dissolve', async (request) => ({ room: store.dissolve(requirePlayer(request), (request.params as { roomId: string }).roomId) }));
  app.get('/api/history', async (request) => ({ settlements: store.historyFor(requirePlayer(request)) }));

  const io = new Server(app.server, { cors: { origin: [/^http:\/\/localhost:\d+$/], credentials: true } });
  const broadcastSnapshots = async (roomId: string) => {
    const table = store.tables.get(roomId); if (!table) return;
    const sockets = await io.in(`table:${roomId}`).fetchSockets();
    for (const socket of sockets) socket.emit('table:snapshot', scheduler.snapshot(roomId, socket.data.playerId));
    io.to(`table:${roomId}`).emit('hand:event', table.recentEvents.at(-1));
  };
  scheduler = new TableScheduler(store, broadcastSnapshots);
  app.addHook('onClose', async () => scheduler.close());

  io.use((socket, next) => {
    const player = store.playerForSession(playerIdFromCookie(socket.handshake.headers.cookie));
    if (!player) return next(new Error('未登录'));
    socket.data.playerId = player.id; socket.data.roomId = undefined; next();
  });
  io.on('connection', (socket) => {
    socket.on('table:join', async ({ roomId }: { roomId: string }, acknowledge) => {
      try {
        const table = store.tableFor(roomId, socket.data.playerId);
        socket.data.roomId = roomId; socket.join(`table:${roomId}`);
        await scheduler.join(roomId);
        acknowledge?.({ ok: true });
      } catch (error) { acknowledge?.({ ok: false, error: (error as Error).message }); }
    });
    socket.on('table:sync', async () => {
      const roomId = socket.data.roomId;
      if (roomId && store.tables.has(roomId)) socket.emit('table:snapshot', scheduler.snapshot(roomId, socket.data.playerId));
    });
    socket.on('table:start', async (acknowledge) => {
      try {
        const roomId = socket.data.roomId; if (!roomId) throw new Error('尚未进入牌桌');
        store.startTable(socket.data.playerId, roomId);
        await scheduler.stateChanged(roomId);
        acknowledge?.({ ok: true });
      } catch (error) { acknowledge?.({ ok: false, error: (error as Error).message }); }
    });
    socket.on('action:submit', async (action: Action, acknowledge) => {
      try {
        const roomId = socket.data.roomId; if (!roomId) throw new Error('尚未进入牌桌');
        const table = store.tables.get(roomId); if (!table) throw new Error('牌桌不存在');
        table.takeAction(socket.data.playerId, action); store.maybeFinalize(roomId);
        await scheduler.stateChanged(roomId); acknowledge?.({ ok: true, sequence: table.recentEvents.at(-1)?.sequence });
      } catch (error) { acknowledge?.({ ok: false, error: (error as Error).message }); }
    });
    socket.on('disconnect', () => {
      const roomId = socket.data.roomId; const table = roomId && store.tables.get(roomId);
      if (table) { try { table.setConnected(socket.data.playerId, false); } catch { /* no-op */ } }
    });
  });
  return { app, io, store };
}

if (process.env.VITEST === undefined) {
  const { app } = await buildServer();
  await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
}
