import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool, type PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PokerTable } from './game-engine.js';
import { buildServer } from './index.js';
import { PostgresTableRepository } from './persistence.js';
import { RiverStore } from './store.js';

const dockerAvailable = existsSync('/var/run/docker.sock') || Boolean(process.env.DOCKER_HOST);
if (process.env.REQUIRE_POSTGRES_TESTS === '1' && !dockerAvailable) {
  throw new Error('PostgreSQL integration tests are required, but no Docker endpoint is available');
}
const describeWithPostgres = dockerAvailable ? describe : describe.skip;

describeWithPostgres('PostgreSQL + Testcontainers integration', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let client: PoolClient;
  let repository: PostgresTableRepository;

  beforeAll(async () => {
    const image = process.env.POSTGRES_TEST_IMAGE ?? 'postgres:16-alpine';
    container = await new PostgreSqlContainer(image).start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await new PostgresTableRepository(pool).migrate();
  }, 120_000);

  beforeEach(async () => {
    client = await pool.connect();
    await client.query('begin');
    repository = new PostgresTableRepository(client);
  });

  afterEach(async () => {
    await client.query('rollback');
    client.release();
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  async function seededTable(): Promise<{ table: PokerTable; roomId: string; hostId: string; guestId: string }> {
    const roomId = randomUUID();
    const hostId = randomUUID();
    const guestId = randomUUID();
    await client.query('insert into guest_players (id, nickname) values ($1, $2), ($3, $4)', [hostId, 'Host', guestId, 'Guest']);
    await client.query(
      `insert into rooms (id, host_player_id, name, max_seats, small_blind, big_blind, invite_code, invite_code_hash)
       values ($1, $2, 'Persistence', 6, 10, 20, $3::varchar, encode(digest(upper($3::text), 'sha256'), 'hex'))`,
      [roomId, hostId, `RIVER-${randomUUID().slice(0, 6).toUpperCase()}`]
    );
    const table = new PokerTable(roomId, 10, 20, 6);
    table.addPlayer({ id: hostId, nickname: 'Host', stack: 500 });
    table.addPlayer({ id: guestId, nickname: 'Guest', stack: 500 });
    table.startNextHand();
    const preparing = table.snapshot(hostId).preparing!;
    table.setShuffleContribution(hostId, preparing.id, `postgres-host-entropy-${hostId}`);
    table.setShuffleContribution(guestId, preparing.id, `postgres-guest-entropy-${guestId}`);
    return { table, roomId, hostId, guestId };
  }

  it('migrates the schema and writes ordered events with the active snapshot in one transaction', async () => {
    const { table, roomId, hostId } = await seededTable();
    const deadline = Date.parse('2026-08-28T12:00:20Z');

    await repository.saveTable(table, deadline);

    const events = await client.query('select sequence, type from table_events where room_id = $1 order by sequence', [roomId]);
    const handEvents = await client.query('select sequence, type from hand_events where hand_id = $1 order by sequence', [table.snapshot(hostId).hand!.id]);
    const snapshots = await client.query('select version, action_deadline_at from active_table_snapshots where room_id = $1', [roomId]);
    expect(events.rows.map((row) => row.sequence)).toEqual(table.exportState().events.map((event) => event.sequence));
    expect(handEvents.rows.map((row) => row.sequence)).toEqual(table.exportState().events.filter((event) => typeof event.payload.handId === 'string').map((event) => event.sequence));
    expect(snapshots.rows).toEqual([
      expect.objectContaining({ version: table.snapshot(hostId).sequence, action_deadline_at: new Date(deadline) })
    ]);

    table.takeAction(table.snapshot(hostId).hand!.currentPlayerId!, { type: 'call' });
    const protectedTiming = {
      actionDeadlineAt: deadline + 10_000,
      nextHandStartsAt: deadline + 20_000,
      reconnectDeadlines: { [hostId]: deadline + 30_000 }
    };
    await repository.saveTable(table, protectedTiming);
    await client.query(
      `update active_table_snapshots
       set state = jsonb_set(state, '{eventSequence}', '0'::jsonb),
           timing = '{"actionDeadlineAt": 1, "reconnectDeadlines": {}}'::jsonb,
           action_deadline_at = '1970-01-01T00:00:00Z'
       where room_id = $1`,
      [roomId]
    );
    await client.query(
      `update table_recovery_checkpoints
       set timing = '{"actionDeadlineAt": 2, "reconnectDeadlines": {}}'::jsonb
       where room_id = $1 and revision = (select max(revision) from table_recovery_checkpoints where room_id = $1)`,
      [roomId]
    );
    const recovered = await repository.loadTable(roomId);
    expect(recovered?.anomalyRecovered).toBe(true);
    expect(recovered?.table.snapshot(hostId)).toEqual(table.snapshot(hostId));
    expect(recovered?.timing).toEqual(protectedTiming);
  });

  it('refuses a delayed older snapshot after a newer action has already persisted', async () => {
    const { table, roomId, hostId } = await seededTable();
    const olderState = table.exportState();
    table.takeAction(table.snapshot(hostId).hand!.currentPlayerId!, { type: 'call' });
    const newerState = table.exportState();
    let releaseOlder!: () => void;
    let olderReachedSnapshot!: () => void;
    const releaseGate = new Promise<void>((resolve) => { releaseOlder = resolve; });
    const reachedGate = new Promise<void>((resolve) => { olderReachedSnapshot = resolve; });
    const delayedRepository = new PostgresTableRepository({
      query: async (text, values) => {
        if (text.includes('insert into active_table_snapshots') && values?.[1] === olderState.eventSequence) {
          olderReachedSnapshot();
          await releaseGate;
        }
        return client.query(text, values);
      }
    });

    const olderSave = delayedRepository.saveTableState(olderState);
    await reachedGate;
    await repository.saveTableState(newerState);
    releaseOlder();
    await olderSave;

    const restored = await repository.loadTable(roomId);
    expect(restored?.table.snapshot(hostId).sequence).toBe(newerState.eventSequence);
    expect(restored?.table.snapshot(hostId)).toEqual(table.snapshot(hostId));

    await repository.saveTableState(olderState);
    expect((await repository.loadTable(roomId))?.table.snapshot(hostId)).toEqual(table.snapshot(hostId));
  });

  it('appends only new events and bounds incremental recovery storage with sparse checkpoints', async () => {
    const { table, roomId, hostId } = await seededTable();
    const initialEventCount = table.exportState().events.length;
    await repository.saveTable(table, { actionDeadlineAt: 1, reconnectDeadlines: {} });

    for (let index = 0; index < 205; index += 1) {
      await repository.saveTable(table, { actionDeadlineAt: index + 2, reconnectDeadlines: {} });
    }

    const persistedEvents = await client.query('select count(*)::int as count from table_events where room_id = $1', [roomId]);
    const recoveryEvents = await client.query(
      `select base_revision::text as base_revision, delta
       from table_state_events where room_id = $1 order by revision`,
      [roomId]
    );
    const checkpoints = await client.query('select count(*)::int as count from table_recovery_checkpoints where room_id = $1', [roomId]);
    expect(persistedEvents.rows[0]?.count).toBe(initialEventCount);
    expect(recoveryEvents.rows.length).toBeLessThanOrEqual(110);
    expect(checkpoints.rows[0]?.count).toBe(2);
    expect(recoveryEvents.rows.every((item) => !Object.hasOwn(item.delta.state, 'events'))).toBe(true);
    expect(recoveryEvents.rows.filter((item) => item.base_revision !== '0').every((item) => item.delta.events.length === 0)).toBe(true);

    await client.query(
      `update active_table_snapshots
       set state = jsonb_set(state, '{eventSequence}', '0'::jsonb)
       where room_id = $1`,
      [roomId]
    );
    const restored = await repository.loadTable(roomId);
    expect(restored?.table.snapshot(hostId)).toEqual(table.snapshot(hostId));
    expect(restored?.timing.actionDeadlineAt).toBe(206);
  });

  it('restores an active hand exactly and records an expired automatic action only once', async () => {
    const store = new RiverStore();
    const host = store.createGuest('Host').player;
    const guest = store.createGuest('Guest').player;
    const room = store.createRoom(host.id, { name: 'Restart', maxSeats: 6, smallBlind: 10, initialChips: 500 });
    store.joinByCode(guest.id, room.inviteCode);
    store.credit(host.id, room.id, guest.id, 500, 'restart-guest-credit');
    const table = store.tableFor(room.id, host.id);
    store.tableFor(room.id, guest.id);
    store.startTable(host.id, room.id);
    const preparing = table.snapshot(host.id).preparing!;
    table.setShuffleContribution(host.id, preparing.id, `postgres-host-entropy-${host.id}`);
    table.setShuffleContribution(guest.id, preparing.id, `postgres-guest-entropy-${guest.id}`);
    const deadline = Date.now() - 1;
    const timing = {
      actionDeadlineAt: deadline,
      nextHandStartsAt: deadline + 2_000,
      reconnectDeadlines: { [guest.id]: deadline + 60_000 }
    };
    await repository.saveStore(store, { [room.id]: timing });

    const persistedCredential = await client.query('select invite_code, invite_code_ciphertext from rooms where id = $1', [room.id]);
    const persistedSnapshot = await client.query('select state::text as state from river_store_snapshots where singleton = true');
    expect(persistedCredential.rows[0]).toMatchObject({ invite_code: null, invite_code_ciphertext: expect.any(String) });
    expect(JSON.stringify(persistedCredential.rows[0])).not.toContain(room.inviteCode);
    expect(persistedSnapshot.rows[0]?.state).not.toContain(room.inviteCode);
    expect((await client.query('select count(*)::int as count from store_aggregate_events')).rows[0]?.count).toBe(1);

    await client.query(
      `update river_store_snapshots
       set state = jsonb_set(state, '{pendingRemovals}', '["corrupt"]'::jsonb)
       where singleton = true`
    );

    const restoredStore = await repository.loadStore();
    expect(repository.storeAnomalyRecovered).toBe(true);
    const restoredTable = restoredStore?.tables.get(room.id);
    const restoredSnapshot = await repository.loadTable(room.id);
    expect(restoredSnapshot?.actionDeadlineAt).toBe(deadline);
    expect(restoredSnapshot?.timing).toEqual(timing);
    expect(restoredTable?.snapshot(host.id)).toEqual(table.snapshot(host.id));
    expect(restoredStore?.roomView(room.id, host.id)).toEqual(store.roomView(room.id, host.id));

    const actor = restoredTable!.snapshot(host.id).hand!.currentPlayerId!;
    restoredTable!.timeout(actor);
    await repository.saveStore(restoredStore!);
    await repository.saveStore(restoredStore!);

    const automaticActions = await client.query(
      `select count(*)::int as count from table_events
       where room_id = $1 and type = 'action' and payload->>'playerId' = $2`,
      [room.id, actor]
    );
    expect(automaticActions.rows[0]?.count).toBe(1);
  });

  it('normalizes presence on the final restored table and schedules reconnect grace', async () => {
    const store = new RiverStore();
    const host = store.createGuest('Host').player;
    const guest = store.createGuest('Guest').player;
    const room = store.createRoom(host.id, { name: 'Presence restart', maxSeats: 6, smallBlind: 10, initialChips: 500 });
    store.joinByCode(guest.id, room.inviteCode);
    store.credit(host.id, room.id, guest.id, 500, 'presence-guest-credit');
    store.tableFor(room.id, host.id);
    store.tableFor(room.id, guest.id);
    await repository.saveStore(store);

    const { app, store: restoredStore } = await buildServer(undefined, repository);
    try {
      expect(restoredStore.tables.get(room.id)?.players.every((player) => !player.connected)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('uses a database sequence for global revisions even when the application clock rolls back', async () => {
    const store = new RiverStore();
    const host = store.createGuest('Clock host').player;
    const room = store.createRoom(host.id, { name: 'Clock rollback', maxSeats: 6, smallBlind: 10, initialChips: 500 });
    await repository.saveStore(store);
    const firstVersion = String((await client.query('select version from river_store_snapshots where singleton = true')).rows[0]?.version);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1);
    try {
      const guest = store.createGuest('Clock guest').player;
      store.joinByCode(guest.id, room.inviteCode);
      await repository.saveStore(store);
      const secondVersion = String((await client.query('select version from river_store_snapshots where singleton = true')).rows[0]?.version);
      expect(BigInt(secondVersion)).toBeGreaterThan(BigInt(firstVersion));
      expect((await repository.loadStore())?.memberships.has(`${room.id}:${guest.id}`)).toBe(true);
      for (let index = 0; index < 25; index += 1) await repository.saveStore(store);
      const aggregateStorage = await client.query(
        `select
           (select count(*)::int from chip_ledger_entries) as ledger_count,
           (select count(*)::int from store_aggregate_events) as aggregate_count,
           (select jsonb_array_length(state->'ledger') from river_store_snapshots where singleton = true) as snapshot_ledger_count,
           (select jsonb_array_length(state->'tables') from river_store_snapshots where singleton = true) as snapshot_table_count,
           (select ledger_cursor from river_store_snapshots where singleton = true) as ledger_cursor`
      );
      expect(aggregateStorage.rows[0]).toMatchObject({
        ledger_count: 1,
        aggregate_count: 2,
        snapshot_ledger_count: 0,
        snapshot_table_count: 0,
        ledger_cursor: 1
      });
    } finally {
      clock.mockRestore();
    }
  });

  it('keeps validating the numeric ledger order after the history reaches double-digit ordinals', async () => {
    const store = new RiverStore();
    const host = store.createGuest('Ledger host').player;
    const room = store.createRoom(host.id, { name: 'Double digit ledger', maxSeats: 6, smallBlind: 10, initialChips: 500 });
    for (let index = 2; index <= 10; index += 1) {
      store.credit(host.id, room.id, host.id, 1, `double-digit-ledger-${index}`);
    }
    expect(store.ledger).toHaveLength(10);
    await repository.saveStore(store);

    store.createGuest('Ordinal 10');

    await expect(repository.saveStore(store)).resolves.toBeUndefined();
    await expect(repository.loadStore()).resolves.toEqual(expect.objectContaining({ ledger: expect.any(Array) }));
  });

  it('does not bless an offline-corrupted global snapshot during a restart migration', async () => {
    const store = new RiverStore();
    const host = store.createGuest('Migration host').player;
    store.createRoom(host.id, { name: 'Migration integrity', maxSeats: 6, smallBlind: 10, initialChips: 500 });
    await repository.saveStore(store);
    await client.query(
      `update river_store_snapshots
       set state = jsonb_set(state, '{pendingRemovals}', '["offline-corruption"]'::jsonb)
       where singleton = true`
    );

    await repository.migrate();
    const restored = await repository.loadStore();

    expect(repository.storeAnomalyRecovered).toBe(true);
    expect(restored?.exportState().pendingRemovals).toEqual([]);
  });

  it('upgrades a baseline plaintext invite only after an application-key encrypted v2 snapshot exists', async () => {
    const legacyStore = new RiverStore();
    const host = legacyStore.createGuest('Legacy host').player;
    const room = legacyStore.createRoom(host.id, { name: 'Legacy room', maxSeats: 6, smallBlind: 10, initialChips: 500 });
    const legacyState = legacyStore.exportState();
    const session = legacyState.sessions[0]!;
    const membership = legacyState.memberships[0]![1];
    const ledger = legacyState.ledger[0]!;
    await client.query('alter table chip_ledger_entries alter column history_hash drop not null');
    await client.query('alter table river_store_snapshots alter column hash_version drop not null');
    await client.query('insert into guest_players (id, nickname, created_at) values ($1, $2, $3)', [host.id, host.nickname, host.createdAt]);
    await client.query(
      `insert into sessions (id, player_id, expires_at) values ($1, $2, $3)`,
      [session[0], session[1].playerId, new Date(session[1].expiresAt)]
    );
    await client.query(
      `insert into rooms (id, host_player_id, name, max_seats, small_blind, big_blind, invite_code, invite_code_hash, invite_code_ciphertext, status, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, encode(digest(upper($7::varchar), 'sha256'), 'hex'), null, $8, $9)`,
      [room.id, room.hostId, room.name, room.maxSeats, room.smallBlind, room.bigBlind, room.inviteCode, room.status, room.createdAt]
    );
    await client.query(
      `insert into memberships (room_id, player_id, role, status, joined_at) values ($1, $2, $3, $4, $5)`,
      [membership.roomId, membership.playerId, membership.role, membership.status, membership.joinedAt]
    );
    await client.query(
      `insert into chip_ledger_entries (id, room_id, player_id, actor_player_id, amount, reason, idempotency_key, ordinal, history_hash, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, 1, null, $8)`,
      [ledger.id, ledger.roomId, ledger.playerId, ledger.actorId, ledger.amount, ledger.reason, ledger.idempotencyKey, ledger.createdAt]
    );
    await client.query(
      `insert into river_store_snapshots (singleton, version, state, ledger_cursor, settlement_cursor, hash_version, state_hash)
       values (true, 0, $1::jsonb, 0, 0, null, encode(digest($1::jsonb::text, 'sha256'), 'hex'))`,
      [JSON.stringify(legacyState)]
    );

    await repository.migrate();

    const persistedInvite = await client.query('select invite_code, invite_code_ciphertext from rooms where id = $1', [room.id]);
    expect(persistedInvite.rows[0]).toMatchObject({ invite_code: null, invite_code_ciphertext: expect.any(String) });
    expect((await client.query('select hash_version from river_store_snapshots where singleton = true')).rows[0]?.hash_version).toBe(2);
    expect((await repository.loadStore())?.rooms.get(room.id)?.inviteCode).toBe(room.inviteCode);

    await client.query('update rooms set invite_code = $2 where id = $1', [room.id, room.inviteCode]);
    await repository.migrate();
    expect((await client.query('select invite_code from rooms where id = $1', [room.id])).rows[0]?.invite_code).toBeNull();
  });

  it('promotes an older aggregate after a corrupt history tail and purges future-only room secrets', async () => {
    const store = new RiverStore();
    const host = store.createGuest('Rollback host').player;
    const retainedRoom = store.createRoom(host.id, { name: 'Retained room', maxSeats: 6, smallBlind: 10, initialChips: 500 });
    store.tableFor(retainedRoom.id, host.id);
    await repository.saveStore(store);

    const discardedRoom = store.createRoom(host.id, { name: 'Discarded room', maxSeats: 6, smallBlind: 10, initialChips: 500 });
    const discardedGuest = store.createGuest('Discarded guest').player;
    store.joinByCode(discardedGuest.id, discardedRoom.inviteCode);
    store.credit(host.id, discardedRoom.id, discardedGuest.id, 500, 'discarded-credit');
    const discardedTable = store.tableFor(discardedRoom.id, host.id);
    store.tableFor(discardedRoom.id, discardedGuest.id);
    store.startTable(host.id, discardedRoom.id);
    const discardedHandId = discardedTable.snapshot(host.id).preparing!.id;
    await repository.saveStore(store);
    await client.query('update chip_ledger_entries set amount = amount + 1 where ordinal = (select max(ordinal) from chip_ledger_entries)');

    const { app, store: restored } = await buildServer(undefined, repository);
    try {
      expect(restored.rooms.has(discardedRoom.id)).toBe(false);
      expect(restored.rooms.has(retainedRoom.id)).toBe(true);
      expect((await client.query('select count(*)::int as count from rooms where id = $1', [discardedRoom.id])).rows[0]?.count).toBe(0);
      expect((await client.query('select count(*)::int as count from active_table_snapshots where room_id = $1', [discardedRoom.id])).rows[0]?.count).toBe(0);
      expect((await client.query('select count(*)::int as count from table_state_events where room_id = $1', [discardedRoom.id])).rows[0]?.count).toBe(0);
      expect((await client.query('select count(*)::int as count from hands where id = $1', [discardedHandId])).rows[0]?.count).toBe(0);

      const recoveredGuest = restored.createGuest('Tail recovered').player;
      restored.joinByCode(recoveredGuest.id, restored.rooms.get(retainedRoom.id)!.inviteCode);
      restored.credit(host.id, retainedRoom.id, recoveredGuest.id, 250, 'after-tail-recovery');
      restored.tableFor(retainedRoom.id, recoveredGuest.id);
      await repository.saveStore(restored);
      expect((await repository.loadStore())?.ledger.at(-1)).toMatchObject({ playerId: recoveredGuest.id, amount: 250 });
    } finally {
      await app.close();
    }
  });

  it('does not attach a later settlement audit when aggregate rollback restores that hand as active', async () => {
    const store = new RiverStore();
    const host = store.createGuest('Active host').player;
    const guest = store.createGuest('Active guest').player;
    const room = store.createRoom(host.id, { name: 'Active rollback', maxSeats: 6, smallBlind: 10, initialChips: 500 });
    store.joinByCode(guest.id, room.inviteCode);
    store.credit(host.id, room.id, guest.id, 500, 'active-guest-credit');
    const table = store.tableFor(room.id, host.id);
    store.tableFor(room.id, guest.id);
    store.startTable(host.id, room.id);
    const preparing = table.snapshot(host.id).preparing!;
    table.setShuffleContribution(host.id, preparing.id, `active-host-${host.id}`);
    table.setShuffleContribution(guest.id, preparing.id, `active-guest-${guest.id}`);
    const handId = table.snapshot(host.id).hand!.id;
    await repository.saveStore(store);

    table.takeAction(table.snapshot(host.id).hand!.currentPlayerId!, { type: 'fold' });
    store.maybeFinalize(room.id);
    await repository.saveStore(store);
    const currentTableRevision = String((await client.query(
      `select table_revisions->>$1 as revision from river_store_snapshots where singleton = true`,
      [room.id]
    )).rows[0]?.revision);
    await client.query(`update active_table_snapshots set state = jsonb_set(state, '{eventSequence}', '0'::jsonb) where room_id = $1`, [room.id]);
    await client.query(
      `update table_recovery_checkpoints set state = jsonb_set(state, '{eventSequence}', '0'::jsonb)
       where room_id = $1 and revision = $2`,
      [room.id, currentTableRevision]
    );
    await client.query(
      `update table_state_events set delta = jsonb_set(delta, '{state,eventSequence}', '0'::jsonb)
       where room_id = $1 and revision = $2`,
      [room.id, currentTableRevision]
    );

    const { app, store: restored } = await buildServer(undefined, repository);
    try {
      const restoredTable = restored.tables.get(room.id)!;
      expect(restoredTable.snapshot(host.id).hand?.status).toBe('active');
      expect(() => restoredTable.auditFor(handId, host.id)).toThrow('手牌尚未结算');
      expect(() => restoredTable.replayFor(handId, host.id)).toThrow('手牌尚未结算');
      expect((await client.query('select count(*)::int as count from hand_audits where hand_id = $1', [handId])).rows[0]?.count).toBe(0);
      expect((await client.query(`select count(*)::int as count from table_events where room_id = $1 and type = 'hand_settled'`, [room.id])).rows[0]?.count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('recovers global state, history, invite material, and tables from one exact aggregate revision', async () => {
    const store = new RiverStore();
    const host = store.createGuest('Exact host').player;
    const room = store.createRoom(host.id, { name: 'Exact recovery', maxSeats: 6, smallBlind: 10, initialChips: 500 });
    store.tableFor(room.id, host.id);
    await repository.saveStore(store);
    const firstRevisionState = store.exportState();

    const guest = store.createGuest('Later guest').player;
    store.joinByCode(guest.id, room.inviteCode);
    store.credit(host.id, room.id, guest.id, 500, 'later-credit');
    store.tableFor(room.id, guest.id);
    store.rotateInvite(host.id, room.id);
    await repository.saveStore(store);
    await client.query(
      `update river_store_snapshots
       set state = jsonb_set(state, '{pendingRemovals}', '["corrupt-current"]'::jsonb)
       where singleton = true`
    );
    await client.query(
      `update store_aggregate_events
       set state = jsonb_set(state, '{pendingRemovals}', '["corrupt-latest"]'::jsonb)
       where version = (select max(version) from store_aggregate_events)`
    );

    const { app, store: restored } = await buildServer(undefined, repository);
    try {
      expect(repository.storeAnomalyRecovered).toBe(true);
      expect(restored.ledger).toEqual(firstRevisionState.ledger);
      expect(restored.rooms.get(room.id)?.inviteCode).toBe(firstRevisionState.rooms[0]?.[1].inviteCode);
      expect(restored.players.has(guest.id)).toBe(false);
      expect(restored.tables.get(room.id)?.players.map((player) => player.id)).toEqual([host.id]);

      const recoveredGuest = restored.createGuest('Recovered guest').player;
      restored.joinByCode(recoveredGuest.id, restored.rooms.get(room.id)!.inviteCode);
      restored.credit(host.id, room.id, recoveredGuest.id, 300, 'post-recovery-credit');
      restored.tableFor(room.id, recoveredGuest.id);
      await repository.saveStore(restored);
      const restarted = await repository.loadStore();
      expect(restarted?.ledger.at(-1)).toMatchObject({ playerId: recoveredGuest.id, amount: 300 });
      expect(restarted?.tables.get(room.id)?.players.some((player) => player.id === recoveredGuest.id)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('rejects relational history whose payload no longer matches its cumulative hash', async () => {
    const store = new RiverStore();
    const host = store.createGuest('History host').player;
    store.createRoom(host.id, { name: 'History integrity', maxSeats: 6, smallBlind: 10, initialChips: 500 });
    await repository.saveStore(store);
    await client.query('update chip_ledger_entries set amount = amount + 1 where ordinal = 1');

    await expect(repository.loadStore()).rejects.toThrow('全局快照、历史或牌桌状态均未通过完整性校验');
  });

  it('recovers a secret-free settled baseline after downtime crosses audit expiry', async () => {
    const { table, roomId, hostId } = await seededTable();
    const handId = table.snapshot(hostId).hand!.id;
    table.takeAction(table.snapshot(hostId).hand!.currentPlayerId!, { type: 'fold' });
    const audit = table.auditFor(handId, hostId);
    await repository.saveTable(table);

    expect(await repository.handCommitment(roomId, handId)).toBe(audit.commitment);
    const protectedSnapshot = await client.query('select state from active_table_snapshots where room_id = $1', [roomId]);
    expect(protectedSnapshot.rows[0]?.state.players.every((player: { hole: unknown[] }) => player.hole.length === 0)).toBe(true);
    expect(JSON.stringify(protectedSnapshot.rows[0]?.state)).not.toContain(audit.serverSeed);
    expect((await repository.loadTable(roomId))?.table.snapshot(hostId)).toEqual(table.snapshot(hostId));
    expect((await client.query(
      'select count(*)::int as count from table_recovery_checkpoints where room_id = $1 and hand_id is null and expires_at is null',
      [roomId]
    )).rows[0]?.count).toBe(1);
    await client.query("update hand_audits set expires_at = now() - interval '1 second' where hand_id = $1", [handId]);
    await client.query(
      `update active_table_snapshots
       set state = jsonb_set(state, '{eventSequence}', '0'::jsonb)
       where room_id = $1`,
      [roomId]
    );

    const restored = await repository.loadTable(roomId);
    expect(restored?.anomalyRecovered).toBe(true);
    expect(restored?.table.players.every((player) => player.hole.length === 0)).toBe(true);
    expect(JSON.stringify(restored?.table.exportState())).not.toContain(audit.serverSeed);
  });

  it('restores an unexpired audit after its settlement event leaves the bounded 500-event snapshot', async () => {
    const { table, roomId, hostId, guestId } = await seededTable();
    const firstHandId = table.snapshot(hostId).hand!.id;
    table.takeAction(table.snapshot(hostId).hand!.currentPlayerId!, { type: 'fold' });
    const firstAudit = table.auditFor(firstHandId, hostId);
    await repository.saveTable(table);

    for (let index = 0; index < 510; index += 1) table.setConnected(hostId, index % 2 === 0);
    table.setConnected(hostId, true);
    table.startNextHand();
    const preparing = table.snapshot(hostId).preparing!;
    table.setShuffleContribution(hostId, preparing.id, `history-host-${hostId}`);
    table.setShuffleContribution(guestId, preparing.id, `history-guest-${guestId}`);
    table.takeAction(table.snapshot(hostId).hand!.currentPlayerId!, { type: 'fold' });
    await repository.saveTable(table);

    expect(table.exportState().events.some((event) => event.type === 'hand_settled' && event.payload.handId === firstHandId)).toBe(false);
    const restored = await repository.loadTable(roomId);
    expect(restored?.table.auditFor(firstHandId, hostId)).toEqual(firstAudit);
    expect(restored?.table.replayFor(firstHandId, hostId)).toMatchObject({ handId: firstHandId });
  });

  it('retains a cancelled shuffle lifecycle without retaining its secret recovery material', async () => {
    const roomId = randomUUID();
    const hostId = randomUUID();
    const guestId = randomUUID();
    await client.query('insert into guest_players (id, nickname) values ($1, $2), ($3, $4)', [hostId, 'Host', guestId, 'Guest']);
    await client.query(
      `insert into rooms (id, host_player_id, name, max_seats, small_blind, big_blind, invite_code, invite_code_hash)
       values ($1, $2, 'Cancelled shuffle', 6, 10, 20, $3::varchar, encode(digest(upper($3::text), 'sha256'), 'hex'))`,
      [roomId, hostId, `RIVER-${randomUUID().slice(0, 6).toUpperCase()}`]
    );
    const table = new PokerTable(roomId, 10, 20, 6);
    table.addPlayer({ id: hostId, nickname: 'Host', stack: 500 });
    table.addPlayer({ id: guestId, nickname: 'Guest', stack: 500 });
    table.startNextHand();
    const cancelledHandId = table.snapshot(hostId).preparing!.id;
    await repository.saveTable(table);
    table.cancelPreparation('test_cancelled');

    await repository.saveTable(table);

    expect((await client.query('select status from hands where id = $1', [cancelledHandId])).rows[0]?.status).toBe('cancelled');
    expect((await client.query('select count(*)::int as count from table_recovery_checkpoints where hand_id = $1', [cancelledHandId])).rows[0]?.count).toBe(0);
    expect((await client.query('select count(*)::int as count from table_state_events where hand_id = $1', [cancelledHandId])).rows[0]?.count).toBe(0);
    expect((await client.query('select count(*)::int as count from table_events where hand_id = $1', [cancelledHandId])).rows[0]?.count).toBe(0);
    expect(JSON.stringify((await client.query('select state from active_table_snapshots where room_id = $1', [roomId])).rows[0]?.state)).not.toMatch(/seed|contributions/);

    table.startNextHand();
    const retryHandId = table.snapshot(hostId).preparing!.id;
    await expect(repository.saveTable(table)).resolves.toBeUndefined();
    expect(retryHandId).not.toBe(cancelledHandId);
    expect((await client.query('select status from hands where room_id = $1 and hand_number = 1 order by status', [roomId])).rows.map((row) => row.status)).toEqual(['cancelled', 'preparing']);
  });

  it('binds a next-hand preparation recovery record to the new hand after a settled boundary', async () => {
    const { table, roomId, hostId } = await seededTable();
    table.takeAction(table.snapshot(hostId).hand!.currentPlayerId!, { type: 'fold' });
    await repository.saveTable(table);
    table.startNextHand();
    const preparingHandId = table.snapshot(hostId).preparing!.id;
    await repository.saveTable(table);

    const preparationRecovery = await client.query(
      `select count(*)::int as count from table_state_events
       where room_id = $1 and hand_id = $2 and expires_at is null`,
      [roomId, preparingHandId]
    );
    expect(preparationRecovery.rows[0]?.count).toBeGreaterThan(0);

    table.cancelPreparation('test_cancelled_after_settlement');
    await repository.saveTable(table);
    expect((await client.query('select count(*)::int as count from table_state_events where hand_id = $1', [preparingHandId])).rows[0]?.count).toBe(0);
    expect((await client.query('select count(*)::int as count from table_recovery_checkpoints where hand_id = $1', [preparingHandId])).rows[0]?.count).toBe(0);
  });

  it('isolates each case with rollback and purges audit material only at the 10-day expiry', async () => {
    const { table, roomId, hostId } = await seededTable();
    const handId = table.snapshot(hostId).hand!.id;
    table.takeAction(table.snapshot(hostId).hand!.currentPlayerId!, { type: 'fold' });
    const audit = table.auditFor(handId, hostId);
    await repository.saveTable(table);

    expect(await repository.purgeExpiredAudits(new Date(Date.parse(audit.expiresAt) - 1))).toBe(0);
    expect((await client.query('select count(*)::int as count from hand_audits where room_id = $1', [roomId])).rows[0]?.count).toBe(1);
    expect(await repository.purgeExpiredAudits(new Date(audit.expiresAt))).toBe(1);
    const afterDowntimeExpiry = await repository.loadTable(roomId);
    expect(afterDowntimeExpiry?.table.players.every((player) => player.hole.length === 0)).toBe(true);
    table.purgeExpiredAudits(Date.parse(audit.expiresAt));
    const sanitizedTiming = { actionDeadlineAt: Date.parse(audit.expiresAt) + 5_000, reconnectDeadlines: {} };
    await repository.saveTable(table, sanitizedTiming);
    const restored = await repository.loadTable(roomId);
    expect(() => restored?.table.auditFor(handId, hostId)).toThrow('审计材料不存在');
    expect((await client.query('select count(*)::int as count from table_events where hand_id = $1', [handId])).rows[0]?.count).toBe(0);
    expect((await client.query('select count(*)::int as count from table_recovery_checkpoints where hand_id = $1', [handId])).rows[0]?.count).toBe(0);
    expect((await client.query('select count(*)::int as count from table_state_events where hand_id = $1', [handId])).rows[0]?.count).toBe(0);
    expect(JSON.stringify(restored?.table.exportState())).not.toContain(audit.serverSeed);

    await client.query(
      `update active_table_snapshots
       set state = jsonb_set(state, '{eventSequence}', '0'::jsonb),
           timing = '{"actionDeadlineAt": 1, "reconnectDeadlines": {}}'::jsonb
       where room_id = $1`,
      [roomId]
    );
    const recoveredSanitizedState = await repository.loadTable(roomId);
    expect(recoveredSanitizedState?.anomalyRecovered).toBe(true);
    expect(recoveredSanitizedState?.table.snapshot(hostId)).toEqual(table.snapshot(hostId));
    expect(recoveredSanitizedState?.timing).toEqual(sanitizedTiming);
    expect(JSON.stringify(recoveredSanitizedState?.table.exportState())).not.toContain(audit.serverSeed);
  });
});
