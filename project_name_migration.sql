-- ============================================================
-- Project name field for Odoo export
-- این فایل را یک‌بار در Supabase SQL Editor اجرا کن.
-- مقدار project_name برای هر task در خروجی Odoo داخل ستون Project قرار می‌گیرد.
-- اگر خالی باشد، برنامه از مقدار template یا مقدار پیش‌فرض استفاده می‌کند.
-- ============================================================

alter table public.tasks
  add column if not exists project_name text;

grant select, insert, update, delete on public.tasks to anon, authenticated;

select id, name, project_name, active
from public.tasks
order by id desc;
