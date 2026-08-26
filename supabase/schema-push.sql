-- 지게차 기사 폰 푸시 구독 저장 테이블
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 한 번 실행하면 됨.

create table if not exists public.push_subs (
  endpoint   text primary key,
  p256dh     text not null,
  auth       text not null,
  name       text default '',
  client_id  text default '',
  created_at timestamptz not null default now(),
  last_ok_at timestamptz
);

-- 이 테이블은 Edge Function(service_role)만 접근함.
-- RLS를 켜고 정책을 만들지 않으면 anon 키로는 읽기/쓰기가 모두 막힘 —
-- 구독 정보(엔드포인트)가 외부에 노출되지 않게 하기 위함.
alter table public.push_subs enable row level security;

-- 혹시 이전에 만들어 둔 공개 정책이 있으면 제거
drop policy if exists "push_subs anon" on public.push_subs;

comment on table public.push_subs is
  '기사 폰 웹푸시 구독. Edge Function notify-drivers 에서만 service_role 로 접근.';
