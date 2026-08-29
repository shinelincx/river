import { readFile } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Pool, type QueryResult } from 'pg';
import { PokerTable, type EngineEvent, type HandAudit, type SerializedTableState } from './game-engine.js';
import { RiverStore, type SerializedRiverStore } from './store.js';
import type { PersistedTableTiming } from './table-scheduler.js';

type Queryable = {
  query(text: string, values?: unknown[]): Promise<QueryResult<Record<string, unknown>>>;
};

export type RestoredTable = { table: PokerTable; actionDeadlineAt?: number; timing: PersistedTableTiming; anomalyRecovered?: boolean };

type TimingInput = number | Partial<PersistedTableTiming> | undefined;
type TableStateWithoutEvents = Omit<SerializedTableState, 'events'>;
type PersistedTableDelta = {
  state: TableStateWithoutEvents;
  events: EngineEvent[];
  eventStartSequence: number;
  timing: PersistedTableTiming;
};

const STORE_HASH_VERSION = 2;
const EMPTY_HISTORY_HASH = createHash('sha256').update('').digest('hex');

type StorePersistenceCandidate = {
  source: 'snapshot' | 'aggregate';
  version: string;
  state: SerializedRiverStore;
  ledgerCursor: number;
  settlementCursor: number;
  ledgerHash: string;
  settlementHash: string;
  tableRevisions: Record<string, string>;
  inviteCiphertexts: Record<string, string>;
};

function nextHistoryHash(previousHash: string, material: string): string {
  return createHash('sha256').update(previousHash + material).digest('hex');
}

function eventsAfter(events: EngineEvent[], sequence: number): EngineEvent[] {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (events[middle].sequence <= sequence) low = middle + 1;
    else high = middle;
  }
  return events.slice(low);
}

function retentionSafeTableState(state: SerializedTableState): SerializedTableState {
  if (state.hand?.status !== 'settled' || state.preparing) return state;
  const settledHandId = state.hand.id;
  return {
    ...state,
    players: state.players.map((player) => ({ ...player, hole: [] })),
    events: state.events.filter((event) => event.payload.handId !== settledHandId),
    actionResults: state.actionResults.filter(([, result]) => result.handId !== settledHandId),
    audits: []
  };
}

function normalizedTiming(input: TimingInput): PersistedTableTiming {
  return typeof input === 'number'
    ? { actionDeadlineAt: input, reconnectDeadlines: {} }
    : { ...input, reconnectDeadlines: input?.reconnectDeadlines ?? {} };
}

function inviteEncryptionKey(): Buffer {
  const configured = process.env.INVITE_CREDENTIAL_KEY ?? 'river-development-only-invite-key';
  return createHash('sha256').update(configured).digest();
}

function encryptInviteCode(code: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', inviteEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((value) => value.toString('base64url')).join('.');
}

function decryptInviteCode(material: string): string {
  const [iv, tag, encrypted] = material.split('.').map((value) => Buffer.from(value, 'base64url'));
  if (!iv || !tag || !encrypted) throw new Error('邀请码密文无效');
  const decipher = createDecipheriv('aes-256-gcm', inviteEncryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export class PostgresTableRepository {
  storeAnomalyRecovered = false;
  private restoredStoreTimings = new Map<string, PersistedTableTiming>();
  private recoveredTableSequences = new Map<string, number>();
  private recoveredStoreCandidate?: StorePersistenceCandidate;

  constructor(private readonly database: Queryable) {}

  static connect(connectionString: string): PostgresTableRepository {
    return new PostgresTableRepository(new Pool({ connectionString }));
  }

  async migrate(): Promise<void> {
    const sql = await readFile(new URL('../../../infra/postgres/init.sql', import.meta.url), 'utf8');
    await this.database.query(sql);
    const legacyInvites = await this.database.query(
      `select id, invite_code from rooms
       where invite_code is not null and invite_code_ciphertext is null`
    );
    if (legacyInvites.rows.length > 0) {
      for (const item of legacyInvites.rows) {
        await this.database.query(
          'update rooms set invite_code_ciphertext = $2 where id = $1 and invite_code_ciphertext is null',
          [item.id, encryptInviteCode(String(item.invite_code))]
        );
      }
      await this.database.query(sql);
    }
    await this.database.query(
      `update rooms room set invite_code = null
       where room.invite_code is not null
         and room.invite_code_ciphertext is not null
         and exists (
           select 1 from river_store_snapshots snapshot,
             jsonb_array_elements(snapshot.state->'rooms') persisted_room
           where snapshot.hash_version = $1
             and persisted_room->>0 = room.id::text
             and snapshot.invite_ciphertexts->>room.id::text = room.invite_code_ciphertext
             and snapshot.state_hash = encode(digest(jsonb_build_object(
               'state', snapshot.state,
               'ledgerCursor', snapshot.ledger_cursor,
               'settlementCursor', snapshot.settlement_cursor,
               'ledgerHash', snapshot.ledger_hash,
               'settlementHash', snapshot.settlement_hash,
               'tableRevisions', snapshot.table_revisions,
               'inviteCiphertexts', snapshot.invite_ciphertexts,
               'hashVersion', snapshot.hash_version
             )::text, 'sha256'), 'hex')
         )`,
      [STORE_HASH_VERSION]
    );
  }

  async saveTable(table: PokerTable, timingInput?: TimingInput): Promise<void> {
    await this.saveTableState(table.exportState(), timingInput);
  }

  async saveTableState(
    stateInput: SerializedTableState,
    timingInput?: TimingInput,
    recovery?: { allowRollback: boolean; baseSequence?: number }
  ): Promise<void> {
    const state = structuredClone(stateInput);
    const timing = normalizedTiming(timingInput);
    const audits = state.audits.filter((audit) => Date.parse(audit.expiresAt) > Date.now());
    const persistedState = retentionSafeTableState({ ...state, audits: [] });
    await this.transaction(async (client) => {
      const previousResult = await client.query(
        `select revision::text as revision, state, timing, snapshot_hash,
           encode(digest(jsonb_build_object('state', state, 'timing', timing)::text, 'sha256'), 'hex') as computed_snapshot_hash
         from active_table_snapshots where room_id = $1`,
        [state.roomId]
      );
      const previous = previousResult.rows[0] as {
        revision?: string;
        state?: SerializedTableState;
        timing?: PersistedTableTiming;
        snapshot_hash?: string;
        computed_snapshot_hash?: string;
      } | undefined;
      const previousIsValid = Boolean(previous?.state && previous.snapshot_hash === previous.computed_snapshot_hash);
      const storedSequence = previousIsValid ? previous!.state!.eventSequence : 0;
      const rollingBack = Boolean(recovery?.allowRollback && recovery.baseSequence !== undefined);
      if (previousIsValid && state.eventSequence < storedSequence && !rollingBack) return;
      const previousRevision = previousIsValid && !rollingBack ? previous?.revision ?? '0' : '0';
      const previousSequence = rollingBack ? recovery?.baseSequence ?? state.eventSequence : storedSequence;
      if (rollingBack) {
        const retainedHandIds = [state.hand?.id, state.preparing?.id].filter((value): value is string => Boolean(value));
        const staleHands = await client.query(
          `select distinct hand_id from table_events
           where room_id = $1 and sequence > $2 and hand_id is not null
             and not (hand_id = any($3::uuid[]))`,
          [state.roomId, previousSequence, retainedHandIds]
        );
        const staleHandIds = staleHands.rows.map((item) => String(item.hand_id));
        if (staleHandIds.length > 0) {
          await client.query('delete from hand_audits where hand_id = any($1::uuid[])', [staleHandIds]);
          await client.query('delete from hand_events where hand_id = any($1::uuid[])', [staleHandIds]);
          await client.query('delete from table_recovery_checkpoints where hand_id = any($1::uuid[])', [staleHandIds]);
          await client.query('delete from table_state_events where hand_id = any($1::uuid[])', [staleHandIds]);
          await client.query(`update hands set status = 'cancelled', settled_at = coalesce(settled_at, now()) where id = any($1::uuid[])`, [staleHandIds]);
        }
        if (state.hand && state.hand.status !== 'settled') {
          await client.query('delete from hand_audits where hand_id = $1', [state.hand.id]);
        }
        await client.query(
          `delete from hand_events event using hands hand
           where event.hand_id = hand.id and hand.room_id = $1 and event.sequence > $2`,
          [state.roomId, previousSequence]
        );
        await client.query('delete from table_events where room_id = $1 and sequence > $2', [state.roomId, previousSequence]);
        await client.query('delete from table_recovery_checkpoints where room_id = $1 and version > $2', [state.roomId, previousSequence]);
        await client.query('delete from table_state_events where room_id = $1 and version > $2', [state.roomId, previousSequence]);
      }
      const newEvents = eventsAfter(state.events, previousSequence);
      const revisionResult = await client.query(`select nextval('table_recovery_revision_seq')::text as revision`);
      const persistenceRevision = String(revisionResult.rows[0]?.revision);
      const handIdsBySequence = new Map<number, string>();
      const cancelledHandIds = new Set<string>();
      for (const event of newEvents) {
        if (typeof event.payload.handId === 'string') handIdsBySequence.set(event.sequence, event.payload.handId);
        if (event.type === 'shuffle_preparation_cancelled' && typeof event.payload.handId === 'string') cancelledHandIds.add(event.payload.handId);
      }

      const hands = new Map<string, { number: number; commitment: string; status: string; settledAt?: string }>();
      if (state.hand) hands.set(state.hand.id, {
        number: state.hand.number,
        commitment: state.hand.commitment,
        status: state.hand.status,
        settledAt: state.hand.status === 'settled' ? audits.find((audit) => audit.handId === state.hand?.id)?.settledAt : undefined
      });
      if (state.preparing) hands.set(state.preparing.id, {
        number: state.preparing.number,
        commitment: state.preparing.commitment,
        status: 'preparing'
      });
      for (const event of newEvents) {
        if (event.type !== 'shuffle_committed' || typeof event.payload.handId !== 'string') continue;
        if (hands.has(event.payload.handId) && !cancelledHandIds.has(event.payload.handId)) continue;
        hands.set(event.payload.handId, {
          number: Number(event.payload.number),
          commitment: String(event.payload.commitment),
          status: cancelledHandIds.has(event.payload.handId) ? 'cancelled' : 'preparing',
          settledAt: cancelledHandIds.has(event.payload.handId) ? new Date().toISOString() : undefined
        });
      }
      for (const [handId, hand] of hands) {
        await client.query(
          `insert into hands (id, room_id, hand_number, commitment_hash, status, settled_at)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (id) do update set status = excluded.status, settled_at = excluded.settled_at`,
          [handId, state.roomId, hand.number, hand.commitment, hand.status, hand.settledAt ?? null]
        );
      }
      for (const event of newEvents) {
        const handId = handIdsBySequence.get(event.sequence);
        await client.query(
          `insert into table_events (room_id, hand_id, sequence, type, payload)
           values ($1, $2, $3, $4, $5::jsonb)
           on conflict (room_id, sequence) do nothing`,
          [state.roomId, handId ?? null, event.sequence, event.type, JSON.stringify(event.payload)]
        );
        if (handId) await client.query(
          `insert into hand_events (hand_id, sequence, type, payload)
           values ($1, $2, $3, $4::jsonb)
           on conflict (hand_id, sequence) do nothing`,
          [handId, event.sequence, event.type, JSON.stringify(event.payload)]
        );
      }
      const activeWrite = await client.query(
        `insert into active_table_snapshots (room_id, version, revision, state, state_hash, action_deadline_at, timing, snapshot_hash, updated_at)
         values ($1, $2, $6, $3::jsonb, encode(digest($3::jsonb::text, 'sha256'), 'hex'), $4, $5::jsonb,
           encode(digest(jsonb_build_object('state', $3::jsonb, 'timing', $5::jsonb)::text, 'sha256'), 'hex'), now())
         on conflict (room_id) do update set
           version = excluded.version,
           revision = excluded.revision,
           state = excluded.state,
           state_hash = excluded.state_hash,
           action_deadline_at = excluded.action_deadline_at,
           timing = excluded.timing,
           snapshot_hash = excluded.snapshot_hash,
           updated_at = now()
         where active_table_snapshots.revision <= excluded.revision
         returning revision`,
        [state.roomId, state.eventSequence, JSON.stringify(persistedState), timing.actionDeadlineAt ? new Date(timing.actionDeadlineAt) : null, JSON.stringify(timing), persistenceRevision]
      );
      if (activeWrite.rowCount !== 1) return;
      const settledBoundary = state.hand?.status === 'settled' && !state.preparing;
      const recoveryHandId = state.preparing?.id ?? state.hand?.id ?? null;
      const recoveryExpiry = settledBoundary ? audits.find((audit) => audit.handId === state.hand?.id)?.expiresAt ?? null : null;
      const retainedRecoveryHandId = settledBoundary ? null : recoveryHandId;
      const retainedRecoveryExpiry = settledBoundary ? null : recoveryExpiry;
      const changesSinceCheckpoint = await client.query(
        `select count(*)::int as count from table_state_events
         where room_id = $1
           and revision > coalesce((select max(revision) from table_recovery_checkpoints where room_id = $1), 0)`,
        [state.roomId]
      );
      const checkpointRequired = !previousIsValid
        || rollingBack
        || newEvents.some((event) => ['shuffle_committed', 'hand_settled', 'shuffle_preparation_cancelled'].includes(event.type))
        || (settledBoundary && !recoveryExpiry)
        || Number(changesSinceCheckpoint.rows[0]?.count ?? 0) >= 99;
      if (checkpointRequired) await client.query(
          `insert into table_recovery_checkpoints (room_id, revision, version, hand_id, state, state_hash, timing, envelope_hash, expires_at)
           values ($1, $7, $2, $3, $4::jsonb, encode(digest($4::jsonb::text, 'sha256'), 'hex'), $5::jsonb,
             encode(digest(jsonb_build_object('state', $4::jsonb, 'timing', $5::jsonb)::text, 'sha256'), 'hex'), $6)
           on conflict (room_id, revision) do nothing`,
          [state.roomId, state.eventSequence, retainedRecoveryHandId, JSON.stringify(persistedState), JSON.stringify(timing), retainedRecoveryExpiry, persistenceRevision]
        );
      const { events: _persistedEvents, ...stateWithoutEvents } = persistedState;
      const deltaEvents = checkpointRequired ? persistedState.events : newEvents;
      const delta: PersistedTableDelta = {
        state: stateWithoutEvents,
        events: deltaEvents,
        eventStartSequence: persistedState.events[0]?.sequence ?? persistedState.eventSequence + 1,
        timing
      };
      await client.query(
        `insert into table_state_events (room_id, revision, base_revision, version, hand_id, delta, delta_hash, expires_at)
         values ($1, $2, $3, $4, $5, $6::jsonb, encode(digest($6::jsonb::text, 'sha256'), 'hex'), $7)
         on conflict (room_id, revision) do nothing`,
        [state.roomId, persistenceRevision, checkpointRequired ? '0' : previousRevision, state.eventSequence, retainedRecoveryHandId, JSON.stringify(delta), retainedRecoveryExpiry]
      );
      if (checkpointRequired) {
        await client.query(
          `delete from table_state_events
           where room_id = $1
             and revision < coalesce(
               (select min(revision) from (
                 select revision from table_recovery_checkpoints where room_id = $1 order by revision desc limit 2
               ) retained_checkpoints),
               $2
             )`,
          [state.roomId, persistenceRevision]
        );
        await client.query(
          `delete from table_recovery_checkpoints
           where room_id = $1
             and revision not in (
               select revision from table_recovery_checkpoints where room_id = $1 order by revision desc limit 2
             )`,
          [state.roomId]
        );
      }
      await client.query(
        `delete from table_events
         where room_id = $1 and hand_id is null and sequence < $2`,
        [state.roomId, Math.max(0, state.eventSequence - 100)]
      );
      if (recoveryHandId && recoveryExpiry) await client.query(
        'update table_recovery_checkpoints set expires_at = $3 where room_id = $1 and hand_id = $2',
        [state.roomId, recoveryHandId, recoveryExpiry]
      );
      if (recoveryHandId && recoveryExpiry) await client.query(
        'update table_state_events set expires_at = $3 where room_id = $1 and hand_id = $2',
        [state.roomId, recoveryHandId, recoveryExpiry]
      );
      for (const handId of cancelledHandIds) {
        await client.query('delete from hand_events where hand_id = $1', [handId]);
        await client.query('delete from table_events where hand_id = $1', [handId]);
        await client.query('delete from table_recovery_checkpoints where hand_id = $1', [handId]);
        await client.query('delete from table_state_events where hand_id = $1', [handId]);
        await client.query(`update hands set status = 'cancelled', settled_at = coalesce(settled_at, now()) where id = $1`, [handId]);
      }
      for (const audit of audits.filter((item) => item.handId === state.hand?.id)) {
        await client.query(
          `insert into hand_audits (hand_id, room_id, participant_ids, material, expires_at)
           values ($1, $2, $3::uuid[], $4::jsonb, $5)
           on conflict (hand_id) do update set material = excluded.material, expires_at = excluded.expires_at`,
          [audit.handId, audit.roomId, audit.participantIds, JSON.stringify(audit), audit.expiresAt]
        );
      }
    });
  }

  async saveStore(store: RiverStore, timings: Record<string, TimingInput> = {}): Promise<void> {
    await this.saveStoreState(store.exportPersistenceState(), timings, {
      ledger: store.ledger,
      settlements: store.settlements
    });
  }

  async saveStoreState(
    stateInput: SerializedRiverStore,
    timings: Record<string, TimingInput> = {},
    historyInput?: Pick<SerializedRiverStore, 'ledger' | 'settlements'>
  ): Promise<void> {
    const state = structuredClone(stateInput);
    const persistedState = structuredClone(state);
    const ledgerHistory = historyInput?.ledger ?? state.ledger;
    const settlementHistory = historyInput?.settlements ?? state.settlements;
    persistedState.ledger = [];
    persistedState.settlements = [];
    persistedState.tables = [];
    const inviteCiphertexts = Object.fromEntries(state.rooms.map(([roomId, room]) => [roomId, encryptInviteCode(room.inviteCode)]));
    for (const [, room] of persistedState.rooms) room.inviteCode = '';
    const aggregateEventState = persistedState;
    await this.transaction(async (client) => {
      const previousSnapshotResult = await client.query(
        `select state, table_revisions, ledger_cursor, settlement_cursor, ledger_hash, settlement_hash, state_hash, hash_version,
           encode(digest(jsonb_build_object(
             'state', state,
             'ledgerCursor', ledger_cursor,
             'settlementCursor', settlement_cursor,
             'ledgerHash', ledger_hash,
             'settlementHash', settlement_hash,
             'tableRevisions', table_revisions,
             'inviteCiphertexts', invite_ciphertexts,
             'hashVersion', hash_version
           )::text, 'sha256'), 'hex') as computed_state_hash
         from river_store_snapshots where singleton = true`
      );
      const previousSnapshot = previousSnapshotResult.rows[0] as {
        state?: SerializedRiverStore;
        table_revisions?: Record<string, string>;
        ledger_cursor?: number;
        settlement_cursor?: number;
        ledger_hash?: string;
        settlement_hash?: string;
        hash_version?: number;
        state_hash?: string;
        computed_state_hash?: string;
      } | undefined;
      let previous = previousSnapshot?.hash_version === STORE_HASH_VERSION
        && previousSnapshot.state_hash === previousSnapshot.computed_state_hash
        && !this.recoveredStoreCandidate
        ? previousSnapshot
        : undefined;
      let recoveringFromAggregate = false;
      let historyValidated = false;
      let recoveredAggregateState: SerializedRiverStore | undefined;
      let recoveredTableRevisions: Record<string, string> = {};
      if (previous) {
        try {
          await this.readValidatedHistory(
            client,
            Number(previous.ledger_cursor ?? 0),
            Number(previous.settlement_cursor ?? 0),
            previous.ledger_hash ?? '',
            previous.settlement_hash ?? ''
          );
          historyValidated = true;
        } catch {
          previous = undefined;
        }
      }
      if (!previous) {
        const recovery = await client.query(
          `select state, table_revisions, ledger_cursor, settlement_cursor, ledger_hash, settlement_hash, hash_version, state_hash,
             encode(digest(jsonb_build_object(
               'state', state,
               'ledgerCursor', ledger_cursor,
               'settlementCursor', settlement_cursor,
               'ledgerHash', ledger_hash,
               'settlementHash', settlement_hash,
               'tableRevisions', table_revisions,
               'inviteCiphertexts', invite_ciphertexts,
               'hashVersion', hash_version
             )::text, 'sha256'), 'hex') as computed_state_hash
           from store_aggregate_events
           where hash_version = $1
             and ($2::bigint is null or version = $2::bigint)
             and state_hash = encode(digest(jsonb_build_object(
               'state', state,
               'ledgerCursor', ledger_cursor,
               'settlementCursor', settlement_cursor,
               'ledgerHash', ledger_hash,
               'settlementHash', settlement_hash,
               'tableRevisions', table_revisions,
               'inviteCiphertexts', invite_ciphertexts,
               'hashVersion', hash_version
             )::text, 'sha256'), 'hex')
           order by version desc`,
          [STORE_HASH_VERSION, this.recoveredStoreCandidate?.version]
        );
        for (const item of recovery.rows) {
          const candidate = item as NonNullable<typeof previousSnapshot>;
          try {
            await this.readValidatedHistory(
              client,
              Number(candidate.ledger_cursor ?? 0),
              Number(candidate.settlement_cursor ?? 0),
              candidate.ledger_hash ?? '',
              candidate.settlement_hash ?? ''
            );
            previous = candidate;
            recoveringFromAggregate = true;
            historyValidated = true;
            recoveredAggregateState = candidate.state;
            recoveredTableRevisions = candidate.table_revisions ?? {};
            break;
          } catch {
            // Try the next retained, independently verified aggregate revision.
          }
        }
      }
      const ledgerCursor = Number(previous?.ledger_cursor ?? 0);
      const settlementCursor = Number(previous?.settlement_cursor ?? 0);
      if (!previous || !historyValidated) {
        const existingHistory = await client.query(
          `select exists(select 1 from chip_ledger_entries) or exists(select 1 from room_settlements) as present`
        );
        if ((existingHistory.rows[0] as { present?: boolean } | undefined)?.present) {
          throw new Error('全局状态历史没有可验证的基准，事务已回滚');
        }
      }
      if (recoveringFromAggregate) {
        await client.query('delete from chip_ledger_entries where ordinal > $1', [ledgerCursor]);
        await client.query('delete from room_settlements where ordinal > $1', [settlementCursor]);
        if (!recoveredAggregateState) throw new Error('聚合恢复基准缺失，事务已回滚');
        const recoveredRoomIds = recoveredAggregateState.rooms.map(([roomId]) => roomId);
        const recoveredTableIds = Object.keys(recoveredTableRevisions);
        const discardedTables = await client.query(
          `select room_id from active_table_snapshots
           where not (room_id = any($1::uuid[]))`,
          [recoveredTableIds]
        );
        const discardedTableIds = discardedTables.rows.map((item) => String(item.room_id));
        if (discardedTableIds.length > 0) {
          await client.query('delete from hand_audits where room_id = any($1::uuid[])', [discardedTableIds]);
          await client.query('delete from hand_events event using hands hand where event.hand_id = hand.id and hand.room_id = any($1::uuid[])', [discardedTableIds]);
          await client.query('delete from table_events where room_id = any($1::uuid[])', [discardedTableIds]);
          await client.query('delete from table_recovery_checkpoints where room_id = any($1::uuid[])', [discardedTableIds]);
          await client.query('delete from table_state_events where room_id = any($1::uuid[])', [discardedTableIds]);
          await client.query('delete from active_table_snapshots where room_id = any($1::uuid[])', [discardedTableIds]);
          await client.query('delete from hands where room_id = any($1::uuid[])', [discardedTableIds]);
        }
        const discardedRooms = await client.query(
          `select id from rooms where not (id = any($1::uuid[]))`,
          [recoveredRoomIds]
        );
        const discardedRoomIds = discardedRooms.rows.map((item) => String(item.id));
        await client.query('delete from memberships');
        await client.query('delete from sessions');
        if (discardedRoomIds.length > 0) await client.query('delete from rooms where id = any($1::uuid[])', [discardedRoomIds]);
        const recoveredPlayerIds = recoveredAggregateState.players.map(([playerId]) => playerId);
        await client.query('delete from guest_players where not (id = any($1::uuid[]))', [recoveredPlayerIds]);
      }
      if (ledgerHistory.length < ledgerCursor || settlementHistory.length < settlementCursor) {
        throw new Error('全局状态历史游标落后，事务已回滚');
      }
      const newLedgerEntries = ledgerHistory.slice(ledgerCursor);
      const newSettlements = settlementHistory.slice(settlementCursor);
      const revisionResult = await client.query(`select nextval('store_aggregate_revision_seq')::text as revision`);
      const saveVersion = String(revisionResult.rows[0]?.revision);
      for (const [, player] of state.players) {
        await client.query(
          `insert into guest_players (id, nickname, created_at) values ($1, $2, $3)
           on conflict (id) do update set nickname = excluded.nickname`,
          [player.id, player.nickname, player.createdAt]
        );
      }
      for (const [sessionId, session] of state.sessions) {
        await client.query(
          `insert into sessions (id, player_id, expires_at) values ($1, $2, $3)
           on conflict (id) do update set expires_at = excluded.expires_at`,
          [sessionId, session.playerId, new Date(session.expiresAt)]
        );
      }
      for (const [, room] of state.rooms) {
        const inviteCredential = state.inviteCredentials?.find(([roomId]) => roomId === room.id)?.[1];
        await client.query(
          `insert into rooms (id, host_player_id, name, max_seats, small_blind, big_blind, invite_code, invite_code_ciphertext, invite_code_hash, invite_version, invite_open, status, created_at, dissolved_at)
           values ($1, $2, $3, $4, $5, $6, null, $7, $8, $9, $10, $11, $12, $13)
           on conflict (id) do update set
             name = excluded.name,
             invite_code = null,
             invite_code_ciphertext = excluded.invite_code_ciphertext,
             invite_code_hash = excluded.invite_code_hash,
             invite_version = excluded.invite_version,
             invite_open = excluded.invite_open,
             status = excluded.status,
             dissolved_at = excluded.dissolved_at`,
          [room.id, room.hostId, room.name, room.maxSeats, room.smallBlind, room.bigBlind, inviteCiphertexts[room.id], inviteCredential?.hash, inviteCredential?.version ?? 1, room.inviteOpen, room.status, room.createdAt, room.dissolvedAt ?? null]
        );
      }
      for (const [, membership] of state.memberships) {
        await client.query(
          `insert into memberships (room_id, player_id, role, status, joined_at) values ($1, $2, $3, $4, $5)
           on conflict (room_id, player_id) do update set role = excluded.role, status = excluded.status`,
          [membership.roomId, membership.playerId, membership.role, membership.status, membership.joinedAt]
        );
      }
      for (const [index, entry] of newLedgerEntries.entries()) {
        await client.query(
          `insert into chip_ledger_entries (id, room_id, player_id, actor_player_id, amount, reason, idempotency_key, created_at, ordinal, history_hash)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9,
             encode(digest(
               coalesce((select history_hash from chip_ledger_entries where ordinal = $9::bigint - 1), '') ||
               jsonb_build_object(
                 'id', $1::uuid, 'roomId', $2::uuid, 'playerId', $3::uuid, 'actorId', $4::uuid,
                 'amount', $5::integer, 'reason', $6::varchar, 'idempotencyKey', $7::varchar,
                 'createdAt', $8::timestamptz, 'ordinal', $9::bigint
               )::text,
               'sha256'
             ), 'hex'))
           on conflict (id) do nothing`,
          [entry.id, entry.roomId, entry.playerId, entry.actorId, entry.amount, entry.reason, entry.idempotencyKey, entry.createdAt, ledgerCursor + index + 1]
        );
      }
      for (const [index, settlement] of newSettlements.entries()) {
        await client.query(
          `insert into room_settlements (room_id, player_id, final_chips, created_at, ordinal, history_hash)
           select $1, $2, $3, $4, $5,
             encode(digest(
               coalesce((select history_hash from room_settlements where ordinal = $5::bigint - 1), '') ||
               jsonb_build_object(
                 'roomId', $1::uuid, 'playerId', $2::uuid, 'finalChips', $3::integer,
                 'createdAt', $4::timestamptz, 'ordinal', $5::bigint
               )::text,
               'sha256'
             ), 'hex')
           where not exists (
             select 1 from room_settlements where room_id = $1 and player_id = $2 and created_at = $4
           )`,
          [settlement.roomId, settlement.playerId, settlement.finalChips, settlement.createdAt, settlementCursor + index + 1]
        );
      }
      const transactionalRepository = new PostgresTableRepository(client);
      for (const [roomId, tableState] of state.tables) {
        await transactionalRepository.saveTableState(tableState, timings[roomId], {
          allowRollback: recoveringFromAggregate,
          baseSequence: this.recoveredTableSequences.get(roomId)
        });
      }
      const tableRevisionResult = await client.query(
        `select room_id, revision::text as revision from active_table_snapshots
         where room_id = any($1::uuid[]) order by room_id`,
        [state.tables.map(([roomId]) => roomId)]
      );
      const tableRevisions = Object.fromEntries(tableRevisionResult.rows.map((item) => [String(item.room_id), String(item.revision)]));
      if (Object.keys(tableRevisions).length !== state.tables.length) throw new Error('牌桌持久化版本不完整，事务已回滚');
      const ledgerHashResult = ledgerHistory.length === 0
        ? undefined
        : await client.query('select history_hash from chip_ledger_entries where ordinal = $1', [ledgerHistory.length]);
      const settlementHashResult = settlementHistory.length === 0
        ? undefined
        : await client.query('select history_hash from room_settlements where ordinal = $1', [settlementHistory.length]);
      const ledgerHash = ledgerHistory.length === 0 ? EMPTY_HISTORY_HASH : String(ledgerHashResult?.rows[0]?.history_hash ?? '');
      const settlementHash = settlementHistory.length === 0 ? EMPTY_HISTORY_HASH : String(settlementHashResult?.rows[0]?.history_hash ?? '');
      if (!ledgerHash || !settlementHash) throw new Error('全局状态历史哈希缺失，事务已回滚');
      await client.query(
        `insert into store_aggregate_events (
           version, type, state, ledger_cursor, settlement_cursor, ledger_hash, settlement_hash,
           table_revisions, invite_ciphertexts, hash_version, state_hash
         )
         values ($1, 'aggregate_state_committed', $2::jsonb, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9,
           encode(digest(jsonb_build_object(
             'state', $2::jsonb,
             'ledgerCursor', $3::integer,
             'settlementCursor', $4::integer,
             'ledgerHash', $5::char(64),
             'settlementHash', $6::char(64),
             'tableRevisions', $7::jsonb,
             'inviteCiphertexts', $8::jsonb,
             'hashVersion', $9::smallint
           )::text, 'sha256'), 'hex'))
         on conflict (version) do nothing`,
        [saveVersion, JSON.stringify(aggregateEventState), ledgerHistory.length, settlementHistory.length, ledgerHash, settlementHash, JSON.stringify(tableRevisions), JSON.stringify(inviteCiphertexts), STORE_HASH_VERSION]
      );
      const snapshotWrite = await client.query(
        `insert into river_store_snapshots (
           singleton, version, state, ledger_cursor, settlement_cursor, ledger_hash, settlement_hash,
           table_revisions, invite_ciphertexts, hash_version, state_hash, updated_at
         )
         values (true, $1, $2::jsonb, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9,
           encode(digest(jsonb_build_object(
             'state', $2::jsonb,
             'ledgerCursor', $3::integer,
             'settlementCursor', $4::integer,
             'ledgerHash', $5::char(64),
             'settlementHash', $6::char(64),
             'tableRevisions', $7::jsonb,
             'inviteCiphertexts', $8::jsonb,
             'hashVersion', $9::smallint
           )::text, 'sha256'), 'hex'), now())
         on conflict (singleton) do update set
           version = excluded.version,
           state = excluded.state,
           ledger_cursor = excluded.ledger_cursor,
           settlement_cursor = excluded.settlement_cursor,
           ledger_hash = excluded.ledger_hash,
           settlement_hash = excluded.settlement_hash,
           table_revisions = excluded.table_revisions,
           invite_ciphertexts = excluded.invite_ciphertexts,
           hash_version = excluded.hash_version,
           state_hash = excluded.state_hash,
           updated_at = now()
         where river_store_snapshots.version <= excluded.version
         returning version`,
        [saveVersion, JSON.stringify(persistedState), ledgerHistory.length, settlementHistory.length, ledgerHash, settlementHash, JSON.stringify(tableRevisions), JSON.stringify(inviteCiphertexts), STORE_HASH_VERSION]
      );
      if (snapshotWrite.rowCount !== 1) throw new Error('全局状态持久化版本落后，事务已回滚');
      await client.query(
        `delete from store_aggregate_events
         where hash_version <> 2
            or state_hash <> encode(digest(jsonb_build_object(
              'state', state,
              'ledgerCursor', ledger_cursor,
              'settlementCursor', settlement_cursor,
              'ledgerHash', ledger_hash,
              'settlementHash', settlement_hash,
              'tableRevisions', table_revisions,
              'inviteCiphertexts', invite_ciphertexts,
              'hashVersion', hash_version
            )::text, 'sha256'), 'hex')
            or version not in (
              select version from store_aggregate_events
              where hash_version = 2
                and state_hash = encode(digest(jsonb_build_object(
                  'state', state,
                  'ledgerCursor', ledger_cursor,
                  'settlementCursor', settlement_cursor,
                  'ledgerHash', ledger_hash,
                  'settlementHash', settlement_hash,
                  'tableRevisions', table_revisions,
                  'inviteCiphertexts', invite_ciphertexts,
                  'hashVersion', hash_version
                )::text, 'sha256'), 'hex')
              order by version desc limit 2
            )`
      );
    });
    this.recoveredTableSequences.clear();
    this.recoveredStoreCandidate = undefined;
  }

  async loadStore(): Promise<RiverStore | undefined> {
    this.storeAnomalyRecovered = false;
    this.restoredStoreTimings.clear();
    this.recoveredTableSequences.clear();
    this.recoveredStoreCandidate = undefined;
    const snapshotResult = await this.database.query(
      `select 'snapshot' as source, version::text as version, state, ledger_cursor, settlement_cursor,
         ledger_hash, settlement_hash, table_revisions, invite_ciphertexts, hash_version, state_hash,
         encode(digest(jsonb_build_object(
           'state', state,
           'ledgerCursor', ledger_cursor,
           'settlementCursor', settlement_cursor,
           'ledgerHash', ledger_hash,
           'settlementHash', settlement_hash,
           'tableRevisions', table_revisions,
           'inviteCiphertexts', invite_ciphertexts,
           'hashVersion', hash_version
         )::text, 'sha256'), 'hex') as computed_state_hash
       from river_store_snapshots where singleton = true`
    );
    const recoveryResult = await this.database.query(
      `select 'aggregate' as source, version::text as version, state, ledger_cursor, settlement_cursor,
         ledger_hash, settlement_hash, table_revisions, invite_ciphertexts, hash_version, state_hash,
         encode(digest(jsonb_build_object(
           'state', state,
           'ledgerCursor', ledger_cursor,
           'settlementCursor', settlement_cursor,
           'ledgerHash', ledger_hash,
           'settlementHash', settlement_hash,
           'tableRevisions', table_revisions,
           'inviteCiphertexts', invite_ciphertexts,
           'hashVersion', hash_version
         )::text, 'sha256'), 'hex') as computed_state_hash
       from store_aggregate_events order by version desc`
    );
    const candidates = [...snapshotResult.rows, ...recoveryResult.rows]
      .filter((item) => Number(item.hash_version) === STORE_HASH_VERSION && item.state_hash === item.computed_state_hash)
      .map((item): StorePersistenceCandidate => ({
        source: item.source as StorePersistenceCandidate['source'],
        version: String(item.version),
        state: item.state as SerializedRiverStore,
        ledgerCursor: Number(item.ledger_cursor),
        settlementCursor: Number(item.settlement_cursor),
        ledgerHash: String(item.ledger_hash),
        settlementHash: String(item.settlement_hash),
        tableRevisions: item.table_revisions as Record<string, string>,
        inviteCiphertexts: item.invite_ciphertexts as Record<string, string>
      }));
    for (const candidate of candidates) {
      try {
        const state = structuredClone(candidate.state);
        const candidateTimings = new Map<string, PersistedTableTiming>();
        const candidateSequences = new Map<string, number>();
        const history = await this.readValidatedHistory(
          this.database,
          candidate.ledgerCursor,
          candidate.settlementCursor,
          candidate.ledgerHash,
          candidate.settlementHash
        );
        state.ledger = history.ledger;
        state.settlements = history.settlements;
        state.tables = [];
        for (const [roomId, revision] of Object.entries(candidate.tableRevisions).sort(([left], [right]) => left.localeCompare(right))) {
          const restored = await this.loadTable(roomId, revision);
          if (!restored) throw new Error(`牌桌恢复状态不存在: ${roomId}`);
          state.tables.push([roomId, restored.table.exportState()]);
          candidateTimings.set(roomId, restored.timing);
          candidateSequences.set(roomId, restored.table.exportState().eventSequence);
          if (restored.anomalyRecovered) this.storeAnomalyRecovered = true;
        }
        if (state.tables.length !== Object.keys(candidate.tableRevisions).length) throw new Error('牌桌恢复版本不完整');
        for (const [roomId, room] of state.rooms) {
          const material = candidate.inviteCiphertexts[roomId];
          if (!material) throw new Error(`邀请码恢复材料不存在: ${roomId}`);
          room.inviteCode = decryptInviteCode(material);
        }
        const store = RiverStore.fromState(state);
        this.restoredStoreTimings = candidateTimings;
        this.recoveredTableSequences = candidate.source === 'aggregate' ? candidateSequences : new Map();
        this.recoveredStoreCandidate = candidate.source === 'aggregate' ? candidate : undefined;
        if (candidate.source !== 'snapshot') this.storeAnomalyRecovered = true;
        return store;
      } catch {
        this.storeAnomalyRecovered = true;
      }
    }
    const authoritativeRows = await this.database.query(
      `select exists(select 1 from guest_players) or exists(select 1 from rooms) as present`
    );
    if ((authoritativeRows.rows[0] as { present?: boolean } | undefined)?.present) {
      throw new Error('全局快照、历史或牌桌状态均未通过完整性校验，拒绝启动');
    }
    return undefined;
  }

  restoredStoreTiming(roomId: string): PersistedTableTiming | undefined {
    const timing = this.restoredStoreTimings.get(roomId);
    return timing ? structuredClone(timing) : undefined;
  }

  private async readValidatedHistory(
    database: Queryable,
    ledgerCursor: number,
    settlementCursor: number,
    ledgerHeadHash: string,
    settlementHeadHash: string
  ): Promise<Pick<SerializedRiverStore, 'ledger' | 'settlements'>> {
    const ledgerResult = await database.query(
      `select id, room_id, player_id, actor_player_id, amount, reason, idempotency_key, created_at,
         ordinal::text as ordinal, history_hash,
         jsonb_build_object(
           'id', id, 'roomId', room_id, 'playerId', player_id, 'actorId', actor_player_id,
           'amount', amount, 'reason', reason, 'idempotencyKey', idempotency_key,
           'createdAt', created_at, 'ordinal', ordinal
         )::text as hash_material
       from chip_ledger_entries where ordinal <= $1 order by ordinal`,
      [ledgerCursor]
    );
    let ledgerHash = '';
    for (const [index, item] of ledgerResult.rows.entries()) {
      if (String(item.ordinal) !== String(index + 1)) throw new Error('积分账本序号不连续');
      ledgerHash = nextHistoryHash(ledgerHash, String(item.hash_material));
      if (ledgerHash !== item.history_hash) throw new Error('积分账本哈希链不匹配');
    }
    const computedLedgerHead = ledgerCursor === 0 ? EMPTY_HISTORY_HASH : ledgerHash;
    if (ledgerResult.rows.length !== ledgerCursor || computedLedgerHead !== ledgerHeadHash) throw new Error('积分账本游标或头哈希不匹配');
    const ledger = ledgerResult.rows.map((item) => ({
      id: item.id as string,
      roomId: item.room_id as string,
      playerId: item.player_id as string,
      actorId: item.actor_player_id as string,
      amount: Number(item.amount),
      reason: item.reason as SerializedRiverStore['ledger'][number]['reason'],
      idempotencyKey: item.idempotency_key as string,
      createdAt: new Date(item.created_at as Date | string).toISOString()
    }));
    const settlementResult = await database.query(
      `select room_id, player_id, final_chips, created_at, ordinal::text as ordinal, history_hash,
         jsonb_build_object(
           'roomId', room_id, 'playerId', player_id, 'finalChips', final_chips,
           'createdAt', created_at, 'ordinal', ordinal
         )::text as hash_material
       from room_settlements where ordinal <= $1 order by ordinal`,
      [settlementCursor]
    );
    let settlementHash = '';
    for (const [index, item] of settlementResult.rows.entries()) {
      if (String(item.ordinal) !== String(index + 1)) throw new Error('结算账本序号不连续');
      settlementHash = nextHistoryHash(settlementHash, String(item.hash_material));
      if (settlementHash !== item.history_hash) throw new Error('结算账本哈希链不匹配');
    }
    const computedSettlementHead = settlementCursor === 0 ? EMPTY_HISTORY_HASH : settlementHash;
    if (settlementResult.rows.length !== settlementCursor || computedSettlementHead !== settlementHeadHash) throw new Error('结算账本游标或头哈希不匹配');
    const settlements = settlementResult.rows.map((item) => ({
      roomId: item.room_id as string,
      playerId: item.player_id as string,
      finalChips: Number(item.final_chips),
      createdAt: new Date(item.created_at as Date | string).toISOString()
    }));
    return { ledger, settlements };
  }

  async loadTable(roomId: string, expectedRevision?: string): Promise<RestoredTable | undefined> {
    const snapshotResult = await this.database.query(
      `select revision::text as revision, state, action_deadline_at, timing, snapshot_hash,
         encode(digest(jsonb_build_object('state', state, 'timing', timing)::text, 'sha256'), 'hex') as computed_snapshot_hash
       from active_table_snapshots where room_id = $1`,
      [roomId]
    );
    let row = snapshotResult.rows[0] as {
      revision?: string;
      state?: SerializedTableState;
      action_deadline_at?: Date | string | null;
      timing?: Partial<PersistedTableTiming> | null;
      snapshot_hash?: string;
      computed_snapshot_hash?: string;
    } | undefined;
    let anomalyRecovered = false;
    if (!row?.state || !row.snapshot_hash || row.snapshot_hash !== row.computed_snapshot_hash || (expectedRevision && row.revision !== expectedRevision)) {
      const checkpointResult = await this.database.query(
        `select revision, version, state, timing
         from table_recovery_checkpoints
         where room_id = $1
           and (expires_at is null or expires_at > now())
           and envelope_hash = encode(digest(jsonb_build_object('state', state, 'timing', timing)::text, 'sha256'), 'hex')
         order by revision`,
        [roomId]
      );
      const stateEventResult = await this.database.query(
        `select revision::text as revision, base_revision::text as base_revision, delta, delta_hash,
           encode(digest(delta::text, 'sha256'), 'hex') as computed_delta_hash
         from table_state_events
         where room_id = $1
           and (expires_at is null or expires_at > now())
         order by revision`,
        [roomId]
      );
      const recoveredByRevision = new Map<string, { state: SerializedTableState; timing: Partial<PersistedTableTiming> }>();
      let recoveredRevision = '0';
      for (const item of checkpointResult.rows) {
        const checkpoint = item as { revision?: string | number; state?: SerializedTableState; timing?: Partial<PersistedTableTiming> };
        if (!checkpoint.revision || !checkpoint.state || !checkpoint.timing) continue;
        const revision = String(checkpoint.revision);
        recoveredByRevision.set(revision, { state: checkpoint.state, timing: checkpoint.timing });
        if (BigInt(revision) > BigInt(recoveredRevision)) recoveredRevision = revision;
      }
      for (const item of stateEventResult.rows) {
        const stateEvent = item as {
          revision?: string;
          base_revision?: string;
          delta?: Partial<PersistedTableDelta>;
          delta_hash?: string;
          computed_delta_hash?: string;
        };
        const revision = stateEvent.revision;
        const baseRevision = stateEvent.base_revision;
        const delta = stateEvent.delta;
        if (!revision || !baseRevision || !delta?.state || !delta.timing || !Array.isArray(delta.events)) continue;
        if (!stateEvent.delta_hash || stateEvent.delta_hash !== stateEvent.computed_delta_hash) continue;
        const base = baseRevision === '0' ? undefined : recoveredByRevision.get(baseRevision);
        if (baseRevision !== '0' && !base) continue;
        const eventStartSequence = Number(delta.eventStartSequence ?? delta.events[0]?.sequence ?? 0);
        const eventsBySequence = new Map<number, EngineEvent>();
        for (const event of [...(base?.state.events ?? []), ...delta.events]) {
          if (event.sequence >= eventStartSequence) eventsBySequence.set(event.sequence, event);
        }
        const events = [...eventsBySequence.values()].sort((left, right) => left.sequence - right.sequence);
        const recovered = {
          state: { ...delta.state, events } as SerializedTableState,
          timing: delta.timing
        };
        recoveredByRevision.set(revision, recovered);
        if (BigInt(revision) > BigInt(recoveredRevision)) recoveredRevision = revision;
      }
      const selectedRevision = expectedRevision ?? recoveredRevision;
      const recovered = recoveredByRevision.get(selectedRevision);
      const recoveredState = recovered?.state;
      const recoveredTiming = recovered?.timing;
      if (!recoveredState || !recoveredTiming) throw new Error(`牌桌快照、检查点与不可变状态事件均未通过完整性校验: ${roomId}`);
      row = {
        state: recoveredState,
        timing: recoveredTiming,
        action_deadline_at: recoveredTiming.actionDeadlineAt ? new Date(recoveredTiming.actionDeadlineAt) : null
      };
      anomalyRecovered = true;
    }
    if (!row?.state) throw new Error(`牌桌恢复状态不存在: ${roomId}`);
    const auditResult = await this.database.query(
      `select audit.material,
         (select max(event.sequence) from hand_events event
          where event.hand_id = audit.hand_id and event.type = 'hand_settled') as settlement_sequence
       from hand_audits audit
       where audit.room_id = $1 and audit.expires_at > now()
       order by audit.created_at`,
      [roomId]
    );
    const state = structuredClone(row.state);
    state.audits = auditResult.rows
      .filter((item) => item.settlement_sequence !== null && Number(item.settlement_sequence) <= state.eventSequence)
      .map((item) => item.material as HandAudit)
      .filter((audit) => state.hand?.id !== audit.handId || state.hand.status === 'settled');
    const deadlineValue = row.action_deadline_at;
    const timing = normalizedTiming(row.timing ?? (deadlineValue ? new Date(deadlineValue).getTime() : undefined));
    return {
      table: PokerTable.fromState(state),
      actionDeadlineAt: timing.actionDeadlineAt,
      timing,
      anomalyRecovered
    };
  }

  async handCommitment(roomId: string, handId: string): Promise<string | undefined> {
    const result = await this.database.query(
      'select commitment_hash from hands where room_id = $1 and id = $2',
      [roomId, handId]
    );
    return (result.rows[0] as { commitment_hash?: string } | undefined)?.commitment_hash;
  }

  async purgeExpiredAudits(currentTime = new Date()): Promise<number> {
    return this.transaction(async (client) => {
      const expired = await client.query('select hand_id from hand_audits where expires_at <= $1', [currentTime]);
      const handIds = expired.rows.map((row) => row.hand_id as string);
      if (handIds.length === 0) return 0;
      await client.query('delete from hand_events where hand_id = any($1::uuid[])', [handIds]);
      await client.query('delete from table_events where hand_id = any($1::uuid[])', [handIds]);
      await client.query('delete from table_recovery_checkpoints where hand_id = any($1::uuid[])', [handIds]);
      await client.query('delete from table_state_events where hand_id = any($1::uuid[])', [handIds]);
      const result = await client.query('delete from hand_audits where hand_id = any($1::uuid[])', [handIds]);
      return result.rowCount ?? 0;
    });
  }

  async close(): Promise<void> {
    if (this.database instanceof Pool) await this.database.end();
  }

  private async transaction<T>(work: (client: Queryable) => Promise<T>): Promise<T> {
    if (!(this.database instanceof Pool)) return work(this.database);
    const client = await this.database.connect();
    try {
      await client.query('begin');
      const result = await work(client as unknown as Queryable);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
}
