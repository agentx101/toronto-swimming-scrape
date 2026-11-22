create extension if not exists pgcrypto;

create table public.portal_contacts (
  id uuid primary key default gen_random_uuid(),
  device_hash text not null unique,
  phone_hash text not null,
  phone_ciphertext text not null,
  phone_iv text not null,
  name_ciphertext text,
  name_iv text,
  whatsapp_consent_at timestamptz not null,
  preferred_filters jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.portal_analytics_events (
  id bigint generated always as identity primary key,
  visitor_hash text not null,
  event_name text not null check (event_name in (
    'page_view', 'scope_changed', 'activity_filter_changed', 'search_started',
    'search_completed', 'contact_prompt_opened', 'contact_prompt_skipped',
    'contact_submitted', 'contact_submit_failed', 'contact_link_clicked'
  )),
  properties jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create index portal_analytics_events_occurred_at_idx on public.portal_analytics_events (occurred_at desc);

create or replace function public.set_portal_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger portal_contacts_set_updated_at
before update on public.portal_contacts
for each row execute function public.set_portal_updated_at();

alter table public.portal_contacts enable row level security;
alter table public.portal_analytics_events enable row level security;

-- The browser has no table access. The Edge Function uses the service role.
revoke all on table public.portal_contacts from anon, authenticated;
revoke all on table public.portal_analytics_events from anon, authenticated;
