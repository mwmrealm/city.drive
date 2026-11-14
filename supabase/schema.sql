-- Run this whole script in Supabase > SQL Editor. It is safe to run again.

create table if not exists public.city_drive_bookings (
    reference text primary key,
    created_at timestamptz not null,
    status text not null check (status in ('new', 'contacted', 'assigned', 'completed', 'cancelled')),
    status_updated_at timestamptz,
    notification_status text not null,
    data jsonb not null
);

create index if not exists city_drive_bookings_created_at_idx
    on public.city_drive_bookings (created_at desc);

alter table public.city_drive_bookings enable row level security;
grant all on table public.city_drive_bookings to service_role;

-- Website settings: cars, prices, contact details, routes, FAQs (single row, id = 1)
create table if not exists public.city_drive_pricing (
    id integer primary key check (id = 1),
    settings jsonb not null,
    updated_at timestamptz not null default now()
);

alter table public.city_drive_pricing enable row level security;
grant all on table public.city_drive_pricing to service_role;

-- Images uploaded from the admin dashboard (car photos, logo)
create table if not exists public.city_drive_media (
    id text primary key,
    content_type text not null,
    data text not null,
    created_at timestamptz not null default now()
);

alter table public.city_drive_media enable row level security;
grant all on table public.city_drive_media to service_role;
