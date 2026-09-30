-- Lupitor voice platform schema. Run once in the Supabase SQL editor, then seed.sql.
-- Call history is append-only by construction: DELETE and TRUNCATE are rejected
-- by triggers, so the test record the brief asks us to keep cannot be cleared.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Agents and immutable versions
-- ---------------------------------------------------------------------------
create table if not exists agents (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  description     text,
  template        text not null check (template in ('collections', 'generic')),
  handles_inbound boolean not null default false,
  created_at      timestamptz not null default now(),
  archived_at     timestamptz
);

create table if not exists agent_versions (
  id             uuid primary key default gen_random_uuid(),
  agent_id       uuid not null references agents(id),
  version        int not null,
  config         jsonb not null,
  notes          text,
  traffic_weight int not null default 0 check (traffic_weight between 0 and 100),
  created_at     timestamptz not null default now(),
  unique (agent_id, version)
);

-- Config of a saved version never changes; only its traffic weight can.
create or replace function forbid_config_edit() returns trigger language plpgsql as $$
begin
  if new.config is distinct from old.config or new.version <> old.version or new.agent_id <> old.agent_id then
    raise exception 'agent_versions are immutable; save a new version instead';
  end if;
  return new;
end $$;
drop trigger if exists agent_versions_immutable on agent_versions;
create trigger agent_versions_immutable before update on agent_versions
  for each row execute function forbid_config_edit();

-- ---------------------------------------------------------------------------
-- Collections data. Offer policies live apart from agent config: whoever edits
-- an agent's prompt cannot see or change the settlement floor.
-- ---------------------------------------------------------------------------
create table if not exists offer_policies (
  portfolio                 text primary key,
  ladder_pct                numeric[] not null,  -- descending; last value is the floor
  max_concessions_per_call  int not null,
  plan_max_months           int not null,
  plan_min_installment      numeric(12,2) not null,
  plan_total_pct            numeric not null,
  first_payment_within_days int not null default 14,
  updated_at                timestamptz not null default now()
);

create table if not exists accounts (
  id             uuid primary key default gen_random_uuid(),
  full_name      text not null,
  phone          text not null,
  dob            date not null,
  zip_code       text not null,
  ssn_last4      text not null,
  account_last4  text not null,
  product        text not null default 'credit card',
  balance        numeric(12,2) not null,
  days_past_due  int not null,
  portfolio      text not null references offer_policies(portfolio),
  timezone       text not null default 'America/New_York',
  created_at     timestamptz not null default now()
);
create index if not exists accounts_phone_idx on accounts(phone);

-- ---------------------------------------------------------------------------
-- Calls, events, arrangements, red-team runs (append-only)
-- ---------------------------------------------------------------------------
create table if not exists calls (
  id               uuid primary key default gen_random_uuid(),
  agent_id         uuid references agents(id),
  agent_version_id uuid references agent_versions(id),
  account_id       uuid references accounts(id),
  room_name        text,
  direction        text not null check (direction in ('outbound', 'inbound', 'browser', 'simulated')),
  source           text not null default 'live' check (source in ('live', 'test', 'redteam')),
  phone            text,
  status           text not null default 'queued',
  outcome          text,
  verified         boolean,
  blocked_reason   text,
  started_at       timestamptz,
  answered_at      timestamptz,
  ended_at         timestamptz,
  duration_seconds int,
  recording_path   text,
  summary          jsonb not null default '{}',
  created_at       timestamptz not null default now()
);
create index if not exists calls_agent_idx on calls(agent_id, created_at desc);
create index if not exists calls_account_idx on calls(account_id, created_at desc);

create table if not exists call_events (
  id      bigserial primary key,
  call_id uuid not null references calls(id),
  ts      timestamptz not null default now(),
  type    text not null,   -- transcript | tool | guard | policy | verification | escalation | arrangement | metric | state | dtmf
  payload jsonb not null default '{}'
);
create index if not exists call_events_call_idx on call_events(call_id, id);

create table if not exists arrangements (
  id                 uuid primary key default gen_random_uuid(),
  call_id            uuid not null references calls(id),
  account_id         uuid not null references accounts(id),
  offer_id           text not null,
  kind               text not null,
  total              numeric(12,2) not null,
  installments       int not null,
  installment_amount numeric(12,2) not null,
  first_due          date not null,
  created_at         timestamptz not null default now()
);

create table if not exists redteam_runs (
  id               uuid primary key default gen_random_uuid(),
  call_id          uuid references calls(id),
  agent_version_id uuid references agent_versions(id),
  persona          text not null,
  passed           boolean not null,
  failures         text[] not null default '{}',
  metrics          jsonb not null default '{}',
  attacker_model   text,
  created_at       timestamptz not null default now()
);

create or replace function forbid_delete() returns trigger language plpgsql as $$
begin
  raise exception 'This table is append-only: % on % is not allowed', tg_op, tg_table_name;
end $$;

do $$
declare t text;
begin
  foreach t in array array['calls', 'call_events', 'arrangements', 'redteam_runs'] loop
    execute format('drop trigger if exists %1$s_no_delete on %1$s', t);
    execute format('create trigger %1$s_no_delete before delete on %1$s for each row execute function forbid_delete()', t);
    execute format('drop trigger if exists %1$s_no_truncate on %1$s', t);
    execute format('create trigger %1$s_no_truncate before truncate on %1$s for each statement execute function forbid_delete()', t);
  end loop;
end $$;

-- Events are evidence: never edited after the fact.
drop trigger if exists call_events_no_update on call_events;
create trigger call_events_no_update before update on call_events
  for each row execute function forbid_delete();

-- ---------------------------------------------------------------------------
-- Contact rules (FDCPA / Regulation F), one source of truth for web and agent
-- ---------------------------------------------------------------------------
create or replace function can_contact(p_account_id uuid)
returns table (allowed boolean, reason text)
language plpgsql stable as $$
declare
  tz       text;
  local_ts timestamp;
  attempts int;
begin
  select a.timezone into tz from accounts a where a.id = p_account_id;
  if tz is null then
    return query select false, 'account not found'; return;
  end if;
  local_ts := now() at time zone tz;
  if extract(hour from local_ts) < 8 or extract(hour from local_ts) >= 21 then
    return query select false, format('outside calling hours: it is %s for the customer (allowed 08:00 to 21:00)', to_char(local_ts, 'HH24:MI'));
    return;
  end if;
  select count(*) into attempts from calls c
   where c.account_id = p_account_id and c.direction = 'outbound'
     and c.status not in ('blocked', 'queued') and c.created_at > now() - interval '7 days';
  if attempts >= 7 then
    return query select false, 'weekly limit reached: 7 call attempts in the last 7 days';
    return;
  end if;
  return query select true, 'ok';
end $$;

-- ---------------------------------------------------------------------------
-- Row level security: the browser never talks to the database directly. Both
-- the web server and the agent use the service role, which bypasses RLS.
-- ---------------------------------------------------------------------------
alter table agents          enable row level security;
alter table agent_versions  enable row level security;
alter table offer_policies  enable row level security;
alter table accounts        enable row level security;
alter table calls           enable row level security;
alter table call_events     enable row level security;
alter table arrangements    enable row level security;
alter table redteam_runs    enable row level security;
