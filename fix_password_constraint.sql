-- حذف محدودیت اشتباه پسورد ۴ رقمی و اضافه کردن ستون‌های تلگرام
alter table if exists public.wt_users
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
