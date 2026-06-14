-- ============================================================

-- محدودیت اشتباه پسورد ۴ رقمی حذف شده است؛ پسورد می‌تواند متن عادی باشد.
alter table if exists public.wt_users drop constraint if exists wt_users_password_4_digits_chk;



-- 2) خاموش کردن RLS برای مدل ساده فعلی، فقط اگر جدول‌ها وجود داشته باشند
do $$
begin
  if to_regclass('public.work_records') is not null then
    alter table public.work_records disable row level security;
  end if;
  if to_regclass('public.tasks') is not null then
    alter table public.tasks disable row level security;
  end if;
  if to_regclass('public.salary_settings') is not null then
    alter table public.salary_settings disable row level security;
  end if;
  if to_regclass('public.profiles') is not null then
    alter table public.profiles disable row level security;
  end if;
end $$;

-- 3) اگر از migration قبلی ستون legacy_user_id مانده، nullable شود
-- خطای «null value in column legacy_user_id» با همین بخش رفع می‌شود.
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

-- 4) ستون‌های لازم روی tasks و work_records
alter table public.tasks
  add column if not exists user_id uuid,
  add column if not exists project_name text,
  add column if not exists active boolean not null default true,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

alter table public.work_records
  add column if not exists user_id uuid,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

-- 5) اگر هنوز کاربری در wt_users نیست ولی profiles داری، از profiles منتقل کن
-- password موقت کاربران منتقل‌شده 0000 است؛ بعداً از پنل ادمین عوضش کن.
do $$
begin
  if to_regclass('public.profiles') is not null then
    insert into public.wt_users (id, username, full_name, role, active, hourly_rate, overtime_coefficient, created_at, password)
    select
      p.id,
      coalesce(nullif(p.username, ''), 'user_' || left(p.id::text, 8)),
      coalesce(p.full_name, ''),
      case when p.role::text = 'admin' then 'admin' else 'user' end,
      coalesce(p.active, true),
      150000,
      1.50,
      coalesce(p.created_at, now()),
      '0000'
    from public.profiles p
    on conflict (id) do nothing;
  end if;
end $$;

-- 6) اگر هیچ ادمینی وجود ندارد، یک ادمین پیش‌فرض بساز
insert into public.wt_users (username, password, full_name, role, active, hourly_rate, overtime_coefficient)
select 'admin', '1610', 'ادمین', 'admin', true, 150000, 1.50
where not exists (select 1 from public.wt_users where role = 'admin');

-- 7) رکوردهای قدیمی بدون user_id را به اولین ادمین وصل کن
do $$
declare
  admin_id uuid;
begin
  select id into admin_id
  from public.wt_users
  where role = 'admin' and active = true
  order by created_at asc
  limit 1;

  if admin_id is not null then
    update public.tasks
    set user_id = admin_id
    where user_id is null;

    update public.work_records
    set user_id = admin_id
    where user_id is null;
  end if;
end $$;

-- 8) حذف foreign keyهای قبلی که user_id را به profiles/auth وصل می‌کردند
-- در مدل ساده، user_id باید به wt_users وصل باشد.
do $$
declare
  r record;
begin
  for r in
    select conrelid::regclass::text as table_name, conname
    from pg_constraint c
    where c.contype = 'f'
      and c.conrelid in ('public.tasks'::regclass, 'public.work_records'::regclass)
      and c.confrelid = 'public.profiles'::regclass
  loop
    execute format('alter table %s drop constraint if exists %I', r.table_name, r.conname);
  end loop;
exception
  when undefined_table then
    null;
end $$;

-- 9) اتصال user_id به wt_users
alter table public.tasks
  drop constraint if exists tasks_user_id_wt_users_fkey;

alter table public.tasks
  add constraint tasks_user_id_wt_users_fkey
  foreign key (user_id) references public.wt_users(id) on delete cascade;

alter table public.work_records
  drop constraint if exists work_records_user_id_wt_users_fkey;

alter table public.work_records
  add constraint work_records_user_id_wt_users_fkey
  foreign key (user_id) references public.wt_users(id) on delete cascade;

-- 10) indexها
create index if not exists tasks_user_id_idx on public.tasks(user_id);
create index if not exists tasks_active_idx on public.tasks(active);
create index if not exists work_records_user_id_idx on public.work_records(user_id);
create index if not exists work_records_work_date_idx on public.work_records(work_date);


-- 10.5) ستون‌های تلگرام برای اتصال آینده به بات
alter table public.wt_users
  drop constraint if exists wt_users_password_4_digits_chk;

alter table public.wt_users
  add column if not exists telegram_username text,
  add column if not exists telegram_chat_id bigint,
  add column if not exists telegram_linked_at timestamptz;

update public.wt_users
set telegram_username = nullif(regexp_replace(trim(telegram_username), '^@+', ''), '')
where telegram_username is not null;

create index if not exists wt_users_telegram_username_idx
  on public.wt_users (lower(telegram_username))
  where telegram_username is not null;

create unique index if not exists wt_users_telegram_chat_id_unique
  on public.wt_users (telegram_chat_id)
  where telegram_chat_id is not null;

-- 11) اجازه دسترسی برای کلاینت ساده Supabase
-- چون RLS خاموش است، این grantها فقط برای راه افتادن مدل ساده هستند.
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.wt_users to anon, authenticated;
grant select, insert, update, delete on public.tasks to anon, authenticated;
grant select, insert, update, delete on public.work_records to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;

-- 12) تست نهایی
select id, username, full_name, role, active, hourly_rate, overtime_coefficient, telegram_username, telegram_chat_id
from public.wt_users
order by created_at desc;
-- ============================================================
-- Projects table + project selection flow
-- این فایل را یک‌بار در Supabase SQL Editor اجرا کن.
-- پروژه‌ها جدا از وظایف مدیریت می‌شوند و هر رکورد ساعت کار project_id دارد.
-- ============================================================

alter table if exists public.projects disable row level security;

create table if not exists public.projects (
  id bigserial primary key,
  user_id uuid references public.wt_users(id) on delete cascade,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.projects disable row level security;

alter table public.tasks
  add column if not exists project_id bigint references public.projects(id) on delete set null,
  add column if not exists project_name text;

alter table public.work_records
  add column if not exists project_id bigint references public.projects(id) on delete set null;

create index if not exists projects_user_id_idx on public.projects(user_id);
create index if not exists projects_active_idx on public.projects(active);
create index if not exists tasks_project_id_idx on public.tasks(project_id);
create index if not exists work_records_project_id_idx on public.work_records(project_id);

create index if not exists projects_user_name_idx
  on public.projects (user_id, lower(name));

-- تبدیل project_nameهای قبلی taskها به پروژه واقعی
insert into public.projects (user_id, name, active)
select distinct t.user_id, trim(t.project_name), true
from public.tasks t
where t.user_id is not null
  and nullif(trim(t.project_name), '') is not null
on conflict do nothing;

update public.tasks t
set project_id = p.id
from public.projects p
where t.project_id is null
  and t.user_id = p.user_id
  and nullif(trim(t.project_name), '') is not null
  and lower(trim(t.project_name)) = lower(p.name);

-- پرکردن project_id رکوردهای قدیمی بر اساس task انتخاب‌شده
update public.work_records wr
set project_id = t.project_id
from public.tasks t
where wr.project_id is null
  and wr.task_id = t.id
  and t.project_id is not null;

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.projects to anon, authenticated;
grant select, insert, update, delete on public.tasks to anon, authenticated;
grant select, insert, update, delete on public.work_records to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;

select id, user_id, name, active
from public.projects
order by created_at desc;
