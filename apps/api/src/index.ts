import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { Server } from 'socket.io';
import { publicEngineEvent, verifyHandAudit } from './game-engine.js';
import { RiverStore } from './store.js';
import { TableScheduler } from './table-scheduler.js';
import { PostgresTableRepository } from './persistence.js';
import { validateRuntimeConfiguration } from './runtime-config.js';

declare module 'fastify' { interface FastifyRequest { riverPlayerId?: string } }

const SESSION_COOKIE = 'river_session';
const playerIdFromCookie = (header?: string) => header?.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`))?.[1];

function validateNickname(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 16) throw new Error('昵称需为 1–16 个字符');
  return value.trim();
}

export async function buildServer(providedStore?: RiverStore, persistence?: PostgresTableRepository): Promise<{ app: FastifyInstance; io: Server; store: RiverStore }> {
  const store = providedStore ?? await persistence?.loadStore() ?? new RiverStore();
  const app = Fastify({ logger: true });
  if (persistence?.storeAnomalyRecovered) app.log.error('全局快照异常，已从不可变聚合事件恢复');
  let scheduler!: TableScheduler;
  let rescheduleAuditPurge = () => undefined;
  let persistenceQueue: Promise<void> = Promise.resolve();
  const persistAll = async () => {
    if (persistence) {
      const timings = Object.fromEntries([...store.tables.keys()].map((roomId) => [roomId, scheduler.exportTiming(roomId)]));
      const pending = persistenceQueue.then(() => persistence.saveStore(store, timings));
      persistenceQueue = pending.then(() => undefined, () => undefined);
      await pending;
    }
    rescheduleAuditPurge();
  };
  let authoritativeQueue: Promise<void> = Promise.resolve();
  const serializeRoom = async <T>(_roomId: string, work: () => Promise<T>): Promise<T> => {
    const previous = authoritativeQueue;
    const current = previous.then(work, work);
    authoritativeQueue = current.then(() => undefined, () => undefined);
    return current;
  };
  const runAuthoritative = async <T>(roomId: string, work: () => Promise<T>): Promise<T> => serializeRoom(roomId, async () => {
    const before = store.exportPersistenceState();
    const ledgerLength = store.ledger.length;
    const settlementLength = store.settlements.length;
    const timing = scheduler?.exportTiming(roomId);
    try {
      return await work();
    } catch (error) {
      const changed = store.ledger.length !== ledgerLength
        || store.settlements.length !== settlementLength
        || JSON.stringify(store.exportPersistenceState()) !== JSON.stringify(before);
      if (changed) {
        store.restoreState({
          ...before,
          ledger: structuredClone(store.ledger.slice(0, ledgerLength)),
          settlements: structuredClone(store.settlements.slice(0, settlementLength))
        });
        if (timing && store.tables.has(roomId)) scheduler.restoreTiming(roomId, timing);
      }
      throw error;
    }
  });
  const invalidInviteAttempts = new Map<string, { count: number; resetAt: number }>();
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
    return runAuthoritative('__identity__', async () => {
      const { player, sessionId } = store.createGuest(validateNickname(body<{ nickname: string }>(request).nickname));
      await persistAll();
      reply.setCookie(SESSION_COOKIE, sessionId, { httpOnly: true, sameSite: 'lax', path: '/', secure: false, maxAge: 60 * 60 * 24 * 30 });
      return { player };
    });
  });
  app.get('/api/me', async (request) => ({ player: store.playerForSession(request.cookies[SESSION_COOKIE]) ?? null }));
  app.get('/api/rooms', async (request) => ({ rooms: store.roomsFor(requirePlayer(request)) }));
  app.post('/api/rooms', async (request) => {
    const input = body<{ name: string; maxSeats: 6 | 9; smallBlind: number; initialChips: number }>(request);
    return runAuthoritative('__rooms__', async () => {
      const room = store.createRoom(requirePlayer(request), input);
      await persistAll();
      return { room };
    });
  });
  app.post('/api/invites/:code/join', async (request, reply) => {
    const key = request.ip;
    const current = invalidInviteAttempts.get(key);
    const attempts = !current || current.resetAt <= Date.now() ? { count: 0, resetAt: Date.now() + 60_000 } : current;
    if (attempts.count >= 5) return reply.status(429).send({ error: '邀请码尝试过多，请稍后再试' });
    try {
      return await runAuthoritative('__invites__', async () => {
        const room = store.joinByCode(requirePlayer(request), (request.params as { code: string }).code);
        await persistAll();
        return { room };
      });
    } catch (error) {
      attempts.count++;
      invalidInviteAttempts.set(key, attempts);
      throw error;
    }
  });
  app.get('/api/rooms/:roomId', async (request) => ({ room: store.roomView((request.params as { roomId: string }).roomId, requirePlayer(request)) }));
  app.get('/api/rooms/:roomId/ledger', async (request) => ({ entries: store.ledgerFor((request.params as { roomId: string }).roomId, requirePlayer(request)) }));
  app.patch('/api/rooms/:roomId/invite', async (request) => {
    const roomId = (request.params as { roomId: string }).roomId;
    return runAuthoritative(roomId, async () => {
      const room = store.setInvite(requirePlayer(request), roomId, Boolean(body<{ open: boolean }>(request).open));
      await persistAll();
      return { room };
    });
  });
  app.post('/api/rooms/:roomId/invite/rotate', async (request) => {
    const roomId = (request.params as { roomId: string }).roomId;
    return runAuthoritative(roomId, async () => {
      const room = store.rotateInvite(requirePlayer(request), roomId);
      await persistAll();
      return { room };
    });
  });
  app.post('/api/rooms/:roomId/credits', async (request) => {
    const roomId = (request.params as { roomId: string }).roomId;
    const input = body<{ playerId: string; amount: number }>(request);
    const key = request.headers['idempotency-key'];
    return runAuthoritative(roomId, async () => {
      const entry = store.credit(requirePlayer(request), roomId, input.playerId, input.amount, typeof key === 'string' ? key : '');
      await scheduler.fundingChanged(roomId);
      return { entry };
    });
  });
  app.post('/api/rooms/:roomId/pause', async (request) => {
    const roomId = (request.params as { roomId: string }).roomId;
    return runAuthoritative(roomId, async () => {
      const room = store.pause(requirePlayer(request), roomId);
      await scheduler.fundingChanged(roomId);
      return { room };
    });
  });
  app.post('/api/rooms/:roomId/resume', async (request) => {
    const roomId = (request.params as { roomId: string }).roomId;
    return runAuthoritative(roomId, async () => {
      const room = store.resume(requirePlayer(request), roomId);
      await scheduler.fundingChanged(roomId);
      return { room };
    });
  });
  app.post('/api/rooms/:roomId/members/:playerId/remove', async (request) => {
    const { roomId, playerId } = request.params as { roomId: string; playerId: string };
    return runAuthoritative(roomId, async () => {
      const membership = store.removeMember(requirePlayer(request), roomId, playerId);
      await scheduler.fundingChanged(roomId);
      return { membership };
    });
  });
  app.post('/api/rooms/:roomId/sit-out', async (request) => {
    const roomId = (request.params as { roomId: string }).roomId;
    const playerId = requirePlayer(request);
    return runAuthoritative(roomId, async () => {
      store.tableFor(roomId, playerId).sitOut(playerId);
      await scheduler.fundingChanged(roomId);
      return { ok: true as const };
    });
  });
  app.post('/api/rooms/:roomId/sit-in', async (request) => {
    const roomId = (request.params as { roomId: string }).roomId;
    const playerId = requirePlayer(request);
    return runAuthoritative(roomId, async () => {
      store.tableFor(roomId, playerId).sitIn(playerId);
      await scheduler.fundingChanged(roomId);
      return { ok: true as const };
    });
  });
  app.post('/api/rooms/:roomId/dissolve', async (request) => {
    const roomId = (request.params as { roomId: string }).roomId;
    return runAuthoritative(roomId, async () => {
      const room = store.dissolve(requirePlayer(request), roomId);
      await scheduler.fundingChanged(roomId);
      return { room };
    });
  });
  app.get('/api/history', async (request) => ({ settlements: store.historyFor(requirePlayer(request)) }));
  app.get('/api/rooms/:roomId/table', async (request) => {
    const roomId = (request.params as { roomId: string }).roomId;
    const playerId = requirePlayer(request);
    store.roomView(roomId, playerId);
    if (!store.tables.has(roomId)) throw new Error('牌桌不存在');
    const snapshot = scheduler.snapshot(roomId, playerId);
    const version = Number((request.query as { version?: string }).version);
    return { snapshot, unchanged: Number.isSafeInteger(version) && version === snapshot.sequence };
  });
  app.get('/api/rooms/:roomId/hands', async (request) => {
    const roomId = (request.params as { roomId: string }).roomId;
    const playerId = requirePlayer(request);
    store.authorizeHandHistory(roomId, playerId);
    const table = store.tables.get(roomId); if (!table) throw new Error('牌桌不存在');
    return { hands: table.handHistoryFor(playerId) };
  });
  app.get('/api/rooms/:roomId/hands/:handId/replay', async (request) => {
    const { roomId, handId } = request.params as { roomId: string; handId: string };
    const playerId = requirePlayer(request);
    store.authorizeHandHistory(roomId, playerId);
    const table = store.tables.get(roomId); if (!table) throw new Error('牌桌不存在');
    return { replay: table.replayFor(handId, playerId) };
  });
  app.get('/api/rooms/:roomId/hands/:handId/audit', async (request) => {
    const { roomId, handId } = request.params as { roomId: string; handId: string };
    const playerId = requirePlayer(request);
    store.authorizeHandHistory(roomId, playerId);
    const table = store.tables.get(roomId); if (!table) throw new Error('牌桌不存在');
    return { audit: table.auditFor(handId, playerId) };
  });
  app.get('/api/rooms/:roomId/hands/:handId/audit/verify', async (request) => {
    const { roomId, handId } = request.params as { roomId: string; handId: string };
    const playerId = requirePlayer(request);
    store.authorizeHandHistory(roomId, playerId);
    const table = store.tables.get(roomId); if (!table) throw new Error('牌桌不存在');
    const audit = table.auditFor(handId, playerId);
    const trustedCommitment = await persistence?.handCommitment(roomId, handId);
    return { verified: verifyHandAudit(audit, trustedCommitment), expiresAt: audit.expiresAt, algorithmVersion: audit.algorithmVersion };
  });

  const io = new Server(app.server, { cors: { origin: [/^http:\/\/localhost:\d+$/], credentials: true } });
  const broadcastSnapshots = async (roomId: string) => {
    const table = store.tables.get(roomId); if (!table) return;
    const sockets = await io.in(`table:${roomId}`).fetchSockets();
    for (const socket of sockets) {
      try {
        store.roomView(roomId, socket.data.playerId);
      } catch {
        await socket.leave(`table:${roomId}`);
        socket.data.roomId = undefined;
        socket.emit('table:revoked');
        continue;
      }
      socket.emit('table:snapshot', scheduler.snapshot(roomId, socket.data.playerId));
      const lastEventSequence = Number(socket.data.lastEventSequence ?? 0);
      for (const event of table.recentEvents.filter((candidate) => candidate.sequence > lastEventSequence)) {
        const publicEvent = publicEngineEvent(event);
        if (publicEvent) socket.emit('hand:event', publicEvent);
      }
      socket.data.lastEventSequence = table.recentEvents.at(-1)?.sequence ?? lastEventSequence;
    }
  };
  scheduler = new TableScheduler(store, broadcastSnapshots, 20_000, 2_000, 60_000, async () => persistAll(), runAuthoritative);
  const purgeExpiredMaterials = async () => {
    const currentTime = Date.now();
    let memoryPurged = 0;
    for (const table of store.tables.values()) memoryPurged += table.purgeExpiredAudits(currentTime);
    const databasePurged = await persistence?.purgeExpiredAudits(new Date(currentTime)) ?? 0;
    if (memoryPurged > 0) await persistAll();
    return memoryPurged + databasePurged;
  };
  if (persistence) {
    for (const roomId of store.tables.keys()) {
      const restored = providedStore ? await persistence.loadTable(roomId) : undefined;
      if (providedStore && restored) store.tables.set(roomId, restored.table);
      if (restored?.anomalyRecovered) app.log.error({ roomId }, '牌桌快照异常，已从受保护恢复事件重建');
      store.tables.get(roomId)?.normalizePresenceAfterRestart();
      scheduler.restoreTiming(roomId, restored?.timing ?? persistence.restoredStoreTiming?.(roomId) ?? { reconnectDeadlines: {} });
    }
    await purgeExpiredMaterials();
    await persistAll();
  }
  let auditPurgeTimer: NodeJS.Timeout | undefined;
  rescheduleAuditPurge = () => {
    if (auditPurgeTimer) clearTimeout(auditPurgeTimer);
    const nextExpiry = [...store.tables.values()].map((table) => table.nextAuditExpiry()).filter((value): value is number => value !== undefined).sort((a, b) => a - b)[0];
    auditPurgeTimer = nextExpiry === undefined ? undefined : setTimeout(() => {
      void runAuthoritative('__maintenance__', purgeExpiredMaterials).finally(rescheduleAuditPurge).catch(() => undefined);
    }, Math.max(0, nextExpiry - Date.now()));
    auditPurgeTimer?.unref();
  };
  rescheduleAuditPurge();
  app.addHook('onClose', async () => {
    if (auditPurgeTimer) clearTimeout(auditPurgeTimer);
    scheduler.close();
    await persistence?.close();
  });

  io.use((socket, next) => {
    const player = store.playerForSession(playerIdFromCookie(socket.handshake.headers.cookie));
    if (!player) return next(new Error('未登录'));
    socket.data.playerId = player.id; socket.data.roomId = undefined; next();
  });
  io.on('connection', (socket) => {
    socket.on('table:join', async ({ roomId }: { roomId: string }, acknowledge) => {
      try {
        await runAuthoritative(roomId, async () => {
          const table = store.tableFor(roomId, socket.data.playerId);
          socket.data.lastEventSequence = table.recentEvents.at(-1)?.sequence ?? 0;
          socket.data.roomId = roomId; await socket.join(`table:${roomId}`);
          await scheduler.presenceChanged(roomId, socket.data.playerId, true);
        });
        acknowledge?.({ ok: true });
      } catch (error) { acknowledge?.({ ok: false, error: (error as Error).message }); }
    });
    socket.on('table:sync', async () => {
      const roomId = socket.data.roomId;
      if (!roomId || !store.tables.has(roomId)) return;
      try {
        store.roomView(roomId, socket.data.playerId);
        socket.emit('table:snapshot', scheduler.snapshot(roomId, socket.data.playerId));
      } catch {
        await socket.leave(`table:${roomId}`);
        socket.data.roomId = undefined;
        socket.emit('table:revoked');
      }
    });
    socket.on('table:start', async (acknowledge) => {
      try {
        const roomId = socket.data.roomId; if (!roomId) throw new Error('尚未进入牌桌');
        await runAuthoritative(roomId, async () => {
          store.roomView(roomId, socket.data.playerId);
          store.startTable(socket.data.playerId, roomId);
          await scheduler.stateChanged(roomId);
        });
        acknowledge?.({ ok: true });
      } catch (error) { acknowledge?.({ ok: false, error: (error as Error).message }); }
    });
    socket.on('action:submit', async (command: unknown, acknowledge) => {
      try {
        const roomId = socket.data.roomId; if (!roomId) throw new Error('尚未进入牌桌');
        const result = await runAuthoritative(roomId, async () => {
          store.roomView(roomId, socket.data.playerId);
          const table = store.tables.get(roomId); if (!table) throw new Error('牌桌不存在');
          const actionResult = table.submitAction(socket.data.playerId, command);
          if (actionResult.accepted) {
            store.maybeFinalize(roomId);
            await scheduler.stateChanged(roomId);
          }
          return actionResult;
        });
        acknowledge?.({ ok: true, sequence: result.sequence });
      } catch (error) { acknowledge?.({ ok: false, error: (error as Error).message }); }
    });
    socket.on('shuffle:contribute', async ({ handId, contribution }: { handId: string; contribution: string }, acknowledge) => {
      try {
        const roomId = socket.data.roomId; if (!roomId) throw new Error('尚未进入牌桌');
        await runAuthoritative(roomId, async () => {
          store.roomView(roomId, socket.data.playerId);
          const table = store.tables.get(roomId); if (!table) throw new Error('牌桌不存在');
          table.setShuffleContribution(socket.data.playerId, handId, contribution);
          store.maybeFinalize(roomId);
          await scheduler.stateChanged(roomId);
        });
        acknowledge?.({ ok: true });
      } catch (error) { acknowledge?.({ ok: false, error: (error as Error).message }); }
    });
    socket.on('disconnect', () => {
      const roomId = socket.data.roomId; const table = roomId && store.tables.get(roomId);
      if (table && roomId) void runAuthoritative(roomId, async () => {
        const remainingSockets = await io.in(`table:${roomId}`).fetchSockets();
        const anotherTabIsPresent = remainingSockets.some((candidate) => candidate.data.playerId === socket.data.playerId);
        if (!anotherTabIsPresent) await scheduler.presenceChanged(roomId, socket.data.playerId, false);
      }).catch(() => undefined);
    });
  });
  return { app, io, store };
}

if (process.env.VITEST === undefined) {
  validateRuntimeConfiguration();
  const persistence = process.env.DATABASE_URL ? PostgresTableRepository.connect(process.env.DATABASE_URL) : undefined;
  await persistence?.migrate();
  const { app } = await buildServer(undefined, persistence);
  await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
}
