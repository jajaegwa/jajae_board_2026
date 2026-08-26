/* 지게차 기사 폰 푸시 발송 Edge Function
   앱을 완전히 종료한 상태에서도 알림이 가게 하는 부분.

   필요한 시크릿 (Supabase 대시보드 > Edge Functions > notify-drivers > Secrets)
     VAPID_PUBLIC   웹푸시 공개키
     VAPID_PRIVATE  웹푸시 개인키   ← 절대 저장소에 올리지 말 것
     VAPID_SUBJECT  연락처 (예: mailto:charlie6623@gmail.com)
     BOARD_PASSCODE 작업판 공유 비밀번호 — 아무나 푸시를 쏘지 못하게 막는 용도

   엔드포인트
     GET  ?config=1                    → { publicKey }  (구독에 필요한 공개키)
     POST { action:'subscribe',   ... } → 구독 저장
     POST { action:'unsubscribe', ... } → 구독 삭제
     POST { action:'notify',      ... } → 전체 기사에게 발송
*/

import { sendPush, type PushSubscription } from './webpush.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC') ?? '';
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE') ?? '';
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.com';
const BOARD_PASSCODE = Deno.env.get('BOARD_PASSCODE') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

/* 길이 정보까지 흘리지 않는 비교 — 비밀번호 대조용 */
function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

async function db(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const url = new URL(req.url);
  // 구독에 필요한 공개키 — 앱이 코드 수정 없이 받아갈 수 있게 함
  if (req.method === 'GET' || url.searchParams.has('config')) {
    return json({ publicKey: VAPID_PUBLIC, configured: !!(VAPID_PUBLIC && VAPID_PRIVATE) });
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }

  // 작업판 비밀번호를 아는 기기만 허용
  if (!BOARD_PASSCODE || !safeEqual(String(body.passcode ?? ''), BOARD_PASSCODE)) {
    return json({ error: 'unauthorized' }, 401);
  }

  const action = String(body.action ?? '');

  if (action === 'subscribe') {
    const sub = body.sub as PushSubscription | undefined;
    if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return json({ error: 'bad subscription' }, 400);
    const res = await db('push_subs?on_conflict=endpoint', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({
        endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth,
        name: String(body.name ?? ''), client_id: String(body.clientId ?? ''),
      }),
    });
    if (!res.ok) return json({ error: 'db', detail: await res.text() }, 500);
    return json({ ok: true });
  }

  if (action === 'unsubscribe') {
    const endpoint = String(body.endpoint ?? '');
    if (!endpoint) return json({ error: 'no endpoint' }, 400);
    await db(`push_subs?endpoint=eq.${encodeURIComponent(endpoint)}`, { method: 'DELETE' });
    return json({ ok: true });
  }

  if (action === 'notify') {
    if (!VAPID_PUBLIC || !VAPID_PRIVATE) return json({ error: 'vapid not configured' }, 503);
    const payload = JSON.stringify({
      title: String(body.title ?? '자재과 작업판'),
      body: String(body.body ?? '새 작업이 등록되었습니다.'),
      url: String(body.url ?? ''),
      tag: String(body.tag ?? 'jajae-drv'),
    });

    const res = await db('push_subs?select=endpoint,p256dh,auth,client_id');
    if (!res.ok) return json({ error: 'db', detail: await res.text() }, 500);
    const rows = await res.json() as Array<{ endpoint: string; p256dh: string; auth: string; client_id: string }>;

    // 등록한 본인 기기에는 보내지 않음
    const exclude = String(body.exclude ?? '');
    const targets = rows.filter(r => !exclude || r.client_id !== exclude);

    const vapid = { subject: VAPID_SUBJECT, publicKey: VAPID_PUBLIC, privateKey: VAPID_PRIVATE };
    let sent = 0; const gone: string[] = [];
    await Promise.all(targets.map(async r => {
      try {
        const out = await sendPush({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, payload, vapid);
        if (out.ok) sent++;
        else if (out.gone) gone.push(r.endpoint);   // 앱을 지웠거나 구독 만료 → 정리 대상
      } catch { /* 한 기기가 실패해도 나머지는 계속 보냄 */ }
    }));

    // 죽은 구독 정리 — 안 하면 매번 실패 요청이 쌓임
    for (const e of gone) {
      await db(`push_subs?endpoint=eq.${encodeURIComponent(e)}`, { method: 'DELETE' });
    }
    return json({ ok: true, sent, removed: gone.length, total: targets.length });
  }

  return json({ error: 'unknown action' }, 400);
});
