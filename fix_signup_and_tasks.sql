-- ============================================================

alter table if exists public.wt_users drop constraint if exists wt_users_password_4_digits_chk;



alter table if exists public.wt_users disable row level security;
alter table if exists public.tasks disable row level security;
alter table if exists public.work_records disable row level security;
alter table if exists public.salary_settings disable row level security;

-- رفع خطای: null value in column legacy_user_id violates not-null constraint
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'tasks' and column_name = 'legacy_user_id'
  ) then
    alter table public.tasks alter column legacy_user_id drop not null;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'work_records' and column_name = 'legacy_user_id'
  ) then
    alter table public.work_records alter column legacy_user_id drop not null;
  end if;
end $$;

alter table public.tasks
  add column if not exists user_id uuid,
  add column if not exists active boolean not null default true,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

alter table public.work_records
  add column if not exists user_id uuid,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.wt_users to anon, authenticated;
grant select, insert, update, delete on public.tasks to anon, authenticated;
grant select, insert, update, delete on public.work_records to anon, authenticated;
grant select, insert, update, delete on public.salary_settings to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;

insert into public.wt_users (username, password, full_name, role, active, hourly_rate, overtime_coefficient)
select 'admin', '1610', 'ادمین', 'admin', true, 150000, 1.50
where not exists (select 1 from public.wt_users where lower(username) = lower('admin'));

select id, username, role, active
from public.wt_users
order by created_at desc;


-- ستون‌های تلگرام
alter table public.wt_users
  add column if not exists telegram_username text,
  add column if not exists telegram_chat_id bigint,
  add column if not exists telegram_linked_at timestamptz;

create index if not exists wt_users_telegram_username_idx
  on public.wt_users (lower(telegram_username))
  where telegram_username is not null;

create unique index if not exists wt_users_telegram_chat_id_unique
  on public.wt_users (telegram_chat_id)
  where telegram_chat_id is not null;
