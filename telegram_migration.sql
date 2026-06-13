-- ============================================================
-- Telegram fields migration for WT users
-- این فایل را یک‌بار در Supabase SQL Editor اجرا کن.
-- telegram_username را کاربر از داخل تنظیمات وارد می‌کند.
-- telegram_chat_id را بعداً بات تلگرام بعد از /start پر می‌کند.
-- ============================================================

-- اگر constraint اشتباه نسخه ۴ رقمی هنوز مانده، حذفش کن.
alter table if exists public.wt_users
  drop constraint if exists wt_users_password_4_digits_chk;

-- ستون‌های تلگرام
alter table public.wt_users
  add column if not exists telegram_username text,
  add column if not exists telegram_chat_id bigint,
  add column if not exists telegram_linked_at timestamptz;

-- تمیز کردن @ از ابتدای یوزرنیم‌های احتمالی
update public.wt_users
set telegram_username = nullif(regexp_replace(trim(telegram_username), '^@+', ''), '')
where telegram_username is not null;

-- ایندکس برای جستجوی سریع توسط بات
create index if not exists wt_users_telegram_username_idx
  on public.wt_users (lower(telegram_username))
  where telegram_username is not null;

-- هر chat_id تلگرام باید فقط به یک کاربر وصل شود.
create unique index if not exists wt_users_telegram_chat_id_unique
  on public.wt_users (telegram_chat_id)
  where telegram_chat_id is not null;

-- دسترسی لازم برای مدل ساده فعلی پروژه
grant select, insert, update, delete on public.wt_users to anon, authenticated;

-- تست
select id, username, full_name, telegram_username, telegram_chat_id, telegram_linked_at
from public.wt_users
order by created_at desc;
