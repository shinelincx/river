create extension if not exists pgcrypto;

create table guest_players (
  id uuid primary key default gen_random_uuid(),
  nickname varchar(16) not null,
  created_at timestamptz not null default now()
);
create table sessions (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references guest_players(id),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create table rooms (
  id uuid primary key default gen_random_uuid(),
  host_player_id uuid not null references guest_players(id),
  name varchar(20) not null,
  max_seats smallint not null check (max_seats in (6, 9)),
  small_blind integer not null check (small_blind > 0),
  big_blind integer not null check (big_blind = small_blind * 2),
  invite_code varchar(12) not null unique,
  invite_open boolean not null default true,
  status varchar(16) not null default 'active',
  created_at timestamptz not null default now(),
  dissolved_at timestamptz
);
create table memberships (
  room_id uuid not null references rooms(id),
  player_id uuid not null references guest_players(id),
  role varchar(16) not null check (role in ('host', 'member')),
  status varchar(16) not null default 'active',
  joined_at timestamptz not null default now(),
  primary key (room_id, player_id)
);
create table chip_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id),
  player_id uuid not null references guest_players(id),
  actor_player_id uuid not null references guest_players(id),
  amount integer not null check (amount <> 0),
  reason varchar(32) not null,
  idempotency_key varchar(128) not null unique,
  created_at timestamptz not null default now()
);
create table hands (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id),
  hand_number integer not null,
  commitment_hash char(64) not null,
  status varchar(16) not null,
  settled_at timestamptz,
  unique(room_id, hand_number)
);
create table hand_events (
  id bigserial primary key,
  hand_id uuid not null references hands(id),
  sequence integer not null,
  type varchar(40) not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique(hand_id, sequence)
);
create table room_settlements (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id),
  player_id uuid not null references guest_players(id),
  final_chips integer not null,
  created_at timestamptz not null default now()
);
