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
