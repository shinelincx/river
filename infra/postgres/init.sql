create extension if not exists pgcrypto;
create sequence if not exists table_recovery_revision_seq;
create sequence if not exists store_aggregate_revision_seq;

create table if not exists guest_players (
  id uuid primary key default gen_random_uuid(),
  nickname varchar(16) not null,
  created_at timestamptz not null default now()
);
create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references guest_players(id),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create table if not exists rooms (
  id uuid primary key default gen_random_uuid(),
  host_player_id uuid not null references guest_players(id),
  name varchar(20) not null,
  max_seats smallint not null check (max_seats in (6, 9)),
  small_blind integer not null check (small_blind in (10, 20, 50, 100)),
  big_blind integer not null check (big_blind = small_blind * 2),
  invite_code varchar(40) unique,
  invite_code_ciphertext text,
  invite_code_hash char(64),
  invite_version integer not null default 1,
  invite_open boolean not null default true,
  status varchar(16) not null default 'active',
  created_at timestamptz not null default now(),
  dissolved_at timestamptz
);
create table if not exists memberships (
  room_id uuid not null references rooms(id),
  player_id uuid not null references guest_players(id),
  role varchar(16) not null check (role in ('host', 'member')),
  status varchar(16) not null default 'active',
  joined_at timestamptz not null default now(),
  primary key (room_id, player_id)
);
create table if not exists chip_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id),
  player_id uuid not null references guest_players(id),
  actor_player_id uuid not null references guest_players(id),
  amount integer not null,
  reason varchar(32) not null,
  idempotency_key varchar(128) not null unique,
  ordinal bigint not null unique,
  history_hash char(64),
  created_at timestamptz not null default now()
);
create table if not exists hands (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id),
  hand_number integer not null,
  commitment_hash char(64) not null,
  status varchar(16) not null,
  settled_at timestamptz
);
create table if not exists hand_events (
  id bigserial primary key,
  hand_id uuid not null references hands(id),
  sequence integer not null,
  type varchar(40) not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique(hand_id, sequence)
);
create table if not exists table_events (
  id bigserial primary key,
  room_id uuid not null references rooms(id),
  hand_id uuid references hands(id),
  sequence integer not null,
  type varchar(40) not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique(room_id, sequence)
);
create table if not exists active_table_snapshots (
  room_id uuid primary key references rooms(id),
  version integer not null,
  revision bigint not null,
  state jsonb not null,
  state_hash char(64),
  action_deadline_at timestamptz,
  timing jsonb not null default '{"reconnectDeadlines": {}}'::jsonb,
  snapshot_hash char(64),
  updated_at timestamptz not null default now()
);
create table if not exists table_recovery_checkpoints (
  room_id uuid not null references rooms(id),
  revision bigint not null,
  version integer not null,
  hand_id uuid references hands(id),
  state jsonb not null,
  state_hash char(64) not null,
  timing jsonb not null default '{"reconnectDeadlines": {}}'::jsonb,
  envelope_hash char(64),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (room_id, revision)
);
create index if not exists table_recovery_checkpoints_expiry_idx on table_recovery_checkpoints(expires_at);
create table if not exists table_state_events (
  room_id uuid not null references rooms(id),
  revision bigint not null,
  base_revision bigint not null,
  version integer not null,
  hand_id uuid references hands(id),
  delta jsonb not null,
  delta_hash char(64) not null,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (room_id, revision)
);
create index if not exists table_state_events_expiry_idx on table_state_events(expires_at);
create table if not exists hand_audits (
  hand_id uuid primary key references hands(id) on delete cascade,
  room_id uuid not null references rooms(id),
  participant_ids uuid[] not null,
  material jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists hand_audits_expiry_idx on hand_audits(expires_at);
create table if not exists river_store_snapshots (
  singleton boolean primary key default true check (singleton),
  version bigint not null default 0,
  state jsonb not null,
  ledger_cursor integer not null default 0,
  settlement_cursor integer not null default 0,
  ledger_hash char(64) not null default encode(digest('', 'sha256'), 'hex'),
  settlement_hash char(64) not null default encode(digest('', 'sha256'), 'hex'),
  table_revisions jsonb not null default '{}'::jsonb,
  invite_ciphertexts jsonb not null default '{}'::jsonb,
  hash_version smallint not null default 2,
  state_hash char(64),
  updated_at timestamptz not null default now()
);
create table if not exists store_aggregate_events (
  version bigint primary key,
  type varchar(40) not null,
  state jsonb not null,
  ledger_cursor integer not null default 0,
  settlement_cursor integer not null default 0,
  ledger_hash char(64) not null default encode(digest('', 'sha256'), 'hex'),
  settlement_hash char(64) not null default encode(digest('', 'sha256'), 'hex'),
  table_revisions jsonb not null default '{}'::jsonb,
  invite_ciphertexts jsonb not null default '{}'::jsonb,
  hash_version smallint not null default 2,
  state_hash char(64) not null,
  created_at timestamptz not null default now()
);
alter table active_table_snapshots add column if not exists timing jsonb not null default '{"reconnectDeadlines": {}}'::jsonb;
alter table active_table_snapshots add column if not exists revision bigint;
update active_table_snapshots set revision = nextval('table_recovery_revision_seq') where revision is null;
alter table active_table_snapshots alter column revision set not null;
alter table active_table_snapshots add column if not exists state_hash char(64);
update active_table_snapshots set state_hash = encode(digest(state::text, 'sha256'), 'hex') where state_hash is null;
alter table active_table_snapshots alter column state_hash set not null;
alter table active_table_snapshots add column if not exists snapshot_hash char(64);
update active_table_snapshots
set snapshot_hash = encode(digest(jsonb_build_object('state', state, 'timing', timing)::text, 'sha256'), 'hex')
where snapshot_hash is null;
alter table active_table_snapshots alter column snapshot_hash set not null;
alter table table_recovery_checkpoints add column if not exists timing jsonb not null default '{"reconnectDeadlines": {}}'::jsonb;
alter table table_recovery_checkpoints add column if not exists revision bigint;
update table_recovery_checkpoints set revision = nextval('table_recovery_revision_seq') where revision is null;
alter table table_recovery_checkpoints alter column revision set not null;
alter table table_recovery_checkpoints drop constraint if exists table_recovery_checkpoints_pkey;
alter table table_recovery_checkpoints add primary key (room_id, revision);
alter table table_recovery_checkpoints add column if not exists envelope_hash char(64);
update table_recovery_checkpoints
set envelope_hash = encode(digest(jsonb_build_object('state', state, 'timing', timing)::text, 'sha256'), 'hex')
where envelope_hash is null;
alter table table_recovery_checkpoints alter column envelope_hash set not null;
alter table table_state_events add column if not exists revision bigint;
update table_state_events set revision = nextval('table_recovery_revision_seq') where revision is null;
alter table table_state_events alter column revision set not null;
alter table table_state_events add column if not exists base_revision bigint;
alter table table_state_events add column if not exists delta jsonb;
alter table table_state_events add column if not exists delta_hash char(64);
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = current_schema() and table_name = 'table_state_events' and column_name = 'envelope'
  ) then
    execute $migration$
      update table_state_events
      set base_revision = coalesce(base_revision, 0),
          delta = coalesce(delta, jsonb_build_object(
            'state', (envelope->'state') - 'events',
            'events', coalesce(envelope->'state'->'events', '[]'::jsonb),
            'eventStartSequence', coalesce(
              (envelope->'state'->'events'->0->>'sequence')::integer,
              (envelope->'state'->>'eventSequence')::integer + 1,
              0
            ),
            'timing', envelope->'timing'
          ))
      where base_revision is null or delta is null
    $migration$;
    execute 'alter table table_state_events alter column envelope drop not null';
    execute 'alter table table_state_events alter column envelope_hash drop not null';
  end if;
end $$;
update table_state_events
set base_revision = coalesce(base_revision, 0),
    delta_hash = coalesce(delta_hash, encode(digest(delta::text, 'sha256'), 'hex'));
alter table table_state_events alter column base_revision set not null;
alter table table_state_events alter column delta set not null;
alter table table_state_events alter column delta_hash set not null;
alter table table_state_events drop constraint if exists table_state_events_pkey;
alter table table_state_events add primary key (room_id, revision);
alter table rooms alter column invite_code type varchar(40);
alter table rooms alter column invite_code drop not null;
alter table rooms add column if not exists invite_code_ciphertext text;
alter table rooms add column if not exists invite_code_hash char(64);
alter table rooms add column if not exists invite_version integer not null default 1;
update rooms set invite_code_hash = encode(digest(upper(invite_code), 'sha256'), 'hex') where invite_code_hash is null;
alter table rooms alter column invite_code_hash set not null;
create unique index if not exists rooms_invite_code_hash_idx on rooms(invite_code_hash);
alter table rooms drop constraint if exists rooms_small_blind_check;
alter table rooms add constraint rooms_small_blind_check check (small_blind in (10, 20, 50, 100));
alter table chip_ledger_entries drop constraint if exists chip_ledger_entries_amount_check;
alter table hands drop constraint if exists hands_room_id_hand_number_key;
create unique index if not exists hands_live_number_idx on hands(room_id, hand_number) where status <> 'cancelled';
create table if not exists room_settlements (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id),
  player_id uuid not null references guest_players(id),
  final_chips integer not null,
  ordinal bigint not null unique,
  history_hash char(64),
  created_at timestamptz not null default now()
);
alter table chip_ledger_entries add column if not exists ordinal bigint;
with ordered_ledger as (
  select id, row_number() over (order by created_at, id) as ordinal from chip_ledger_entries
)
update chip_ledger_entries entry
set ordinal = ordered_ledger.ordinal
from ordered_ledger
where entry.id = ordered_ledger.id and entry.ordinal is null;
alter table chip_ledger_entries alter column ordinal set not null;
create unique index if not exists chip_ledger_entries_ordinal_idx on chip_ledger_entries(ordinal);
alter table room_settlements add column if not exists ordinal bigint;
with ordered_settlements as (
  select id, row_number() over (order by created_at, id) as ordinal from room_settlements
)
update room_settlements settlement
set ordinal = ordered_settlements.ordinal
from ordered_settlements
where settlement.id = ordered_settlements.id and settlement.ordinal is null;
alter table room_settlements alter column ordinal set not null;
create unique index if not exists room_settlements_ordinal_idx on room_settlements(ordinal);
alter table chip_ledger_entries add column if not exists history_hash char(64);
alter table room_settlements add column if not exists history_hash char(64);
do $$
declare
  item record;
  previous_hash text := '';
begin
  for item in
    select id, ordinal, jsonb_build_object(
      'id', id, 'roomId', room_id, 'playerId', player_id, 'actorId', actor_player_id,
      'amount', amount, 'reason', reason, 'idempotencyKey', idempotency_key,
      'createdAt', created_at, 'ordinal', ordinal
    )::text as material
    from chip_ledger_entries order by ordinal
  loop
    update chip_ledger_entries
    set history_hash = encode(digest(previous_hash || item.material, 'sha256'), 'hex')
    where id = item.id and history_hash is null;
    select history_hash into previous_hash from chip_ledger_entries where id = item.id;
  end loop;
end $$;
do $$
declare
  item record;
  previous_hash text := '';
begin
  for item in
    select id, ordinal, jsonb_build_object(
      'roomId', room_id, 'playerId', player_id, 'finalChips', final_chips,
      'createdAt', created_at, 'ordinal', ordinal
    )::text as material
    from room_settlements order by ordinal
  loop
    update room_settlements
    set history_hash = encode(digest(previous_hash || item.material, 'sha256'), 'hex')
    where id = item.id and history_hash is null;
    select history_hash into previous_hash from room_settlements where id = item.id;
  end loop;
end $$;
alter table chip_ledger_entries alter column history_hash set not null;
alter table room_settlements alter column history_hash set not null;

alter table river_store_snapshots add column if not exists version bigint not null default 0;
alter table river_store_snapshots add column if not exists ledger_cursor integer not null default 0;
alter table river_store_snapshots add column if not exists settlement_cursor integer not null default 0;
alter table river_store_snapshots add column if not exists ledger_hash char(64);
alter table river_store_snapshots add column if not exists settlement_hash char(64);
alter table river_store_snapshots add column if not exists table_revisions jsonb;
alter table river_store_snapshots add column if not exists invite_ciphertexts jsonb;
alter table river_store_snapshots add column if not exists hash_version smallint;
alter table river_store_snapshots add column if not exists state_hash char(64);
alter table store_aggregate_events add column if not exists ledger_cursor integer not null default 0;
alter table store_aggregate_events add column if not exists settlement_cursor integer not null default 0;
alter table store_aggregate_events add column if not exists ledger_hash char(64);
alter table store_aggregate_events add column if not exists settlement_hash char(64);
alter table store_aggregate_events add column if not exists table_revisions jsonb;
alter table store_aggregate_events add column if not exists invite_ciphertexts jsonb;
alter table store_aggregate_events add column if not exists hash_version smallint;

update river_store_snapshots
set ledger_cursor = greatest(ledger_cursor, coalesce(jsonb_array_length(state->'ledger'), 0)),
    settlement_cursor = greatest(settlement_cursor, coalesce(jsonb_array_length(state->'settlements'), 0))
where hash_version is null;
with legacy as (
  select snapshot.singleton,
    coalesce((select history_hash from chip_ledger_entries where ordinal = snapshot.ledger_cursor), encode(digest('', 'sha256'), 'hex')) as ledger_hash,
    coalesce((select history_hash from room_settlements where ordinal = snapshot.settlement_cursor), encode(digest('', 'sha256'), 'hex')) as settlement_hash,
    coalesce((select jsonb_object_agg(room_id, revision::text) from active_table_snapshots), '{}'::jsonb) as table_revisions,
    coalesce((select jsonb_object_agg(id, invite_code_ciphertext) from rooms where invite_code_ciphertext is not null), '{}'::jsonb) as invite_ciphertexts
  from river_store_snapshots snapshot
  where snapshot.hash_version is null
    and snapshot.state_hash in (
      encode(digest(snapshot.state::text, 'sha256'), 'hex'),
      encode(digest(jsonb_build_object(
        'state', snapshot.state,
        'ledgerCursor', snapshot.ledger_cursor,
        'settlementCursor', snapshot.settlement_cursor
      )::text, 'sha256'), 'hex')
    )
    and (select count(*) from chip_ledger_entries where ordinal <= snapshot.ledger_cursor) = snapshot.ledger_cursor
    and (select count(*) from room_settlements where ordinal <= snapshot.settlement_cursor) = snapshot.settlement_cursor
    and not exists (
      select 1
      from jsonb_array_elements(snapshot.state->'rooms') persisted_room
      left join rooms room on room.id::text = persisted_room->>0
      where room.invite_code_ciphertext is null
    )
)
update river_store_snapshots snapshot
set ledger_hash = legacy.ledger_hash,
    settlement_hash = legacy.settlement_hash,
    table_revisions = legacy.table_revisions,
    invite_ciphertexts = legacy.invite_ciphertexts,
    hash_version = 2,
    state_hash = encode(digest(jsonb_build_object(
      'state', snapshot.state,
      'ledgerCursor', snapshot.ledger_cursor,
      'settlementCursor', snapshot.settlement_cursor,
      'ledgerHash', legacy.ledger_hash,
      'settlementHash', legacy.settlement_hash,
      'tableRevisions', legacy.table_revisions,
      'inviteCiphertexts', legacy.invite_ciphertexts,
      'hashVersion', 2::smallint
    )::text, 'sha256'), 'hex')
from legacy where snapshot.singleton = legacy.singleton;
alter table river_store_snapshots alter column ledger_hash set default encode(digest('', 'sha256'), 'hex');
alter table river_store_snapshots alter column settlement_hash set default encode(digest('', 'sha256'), 'hex');
alter table river_store_snapshots alter column table_revisions set default '{}'::jsonb;
alter table river_store_snapshots alter column invite_ciphertexts set default '{}'::jsonb;
alter table river_store_snapshots alter column hash_version set default 2;
alter table store_aggregate_events alter column ledger_hash set default encode(digest('', 'sha256'), 'hex');
alter table store_aggregate_events alter column settlement_hash set default encode(digest('', 'sha256'), 'hex');
alter table store_aggregate_events alter column table_revisions set default '{}'::jsonb;
alter table store_aggregate_events alter column invite_ciphertexts set default '{}'::jsonb;
alter table store_aggregate_events alter column hash_version set default 2;
