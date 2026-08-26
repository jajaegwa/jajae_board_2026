/* Web Push (RFC 8291 aes128gcm) + VAPID (RFC 8292)
   WebCrypto만 사용 — Deno(Supabase Edge Function)와 Node 양쪽에서 그대로 동작함.
   npm 패키지(web-push)는 Deno의 Node 호환 계층에 의존해 깨질 여지가 있어 직접 구현함.
   구현이 맞는지는 RFC 8291 5절의 공식 테스트 벡터로 검증함(test 참고). */

export const b64u = {
  encode(buf: ArrayBuffer | Uint8Array): string {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(str: string): Uint8Array {
    const s = str.replace(/-/g, '+').replace(/_/g, '/');
    const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
    const bin = atob(s + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

function concat(...arrs: Uint8Array[]): Uint8Array {
  const len = arrs.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

/* HKDF (RFC 5869) — WebCrypto의 deriveBits로 처리 */
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource },
    key,
    len * 8,
  );
  return new Uint8Array(bits);
}

/* 비압축 P-256 공개키(0x04||X||Y, 65바이트)를 CryptoKey로 */
async function importPublicRaw(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}

/* 32바이트 원시 개인키 d를 JWK로 가져오기 — 대응 공개키가 있어야 import가 가능함 */
async function importPrivateRaw(d: Uint8Array, pub: Uint8Array, usage: 'ECDH' | 'ECDSA'): Promise<CryptoKey> {
  const jwk: JsonWebKey = {
    kty: 'EC', crv: 'P-256', ext: true,
    d: b64u.encode(d),
    x: b64u.encode(pub.slice(1, 33)),
    y: b64u.encode(pub.slice(33, 65)),
  };
  const algo = usage === 'ECDH'
    ? { name: 'ECDH', namedCurve: 'P-256' }
    : { name: 'ECDSA', namedCurve: 'P-256' };
  return crypto.subtle.importKey('jwk', jwk, algo, false, usage === 'ECDH' ? ['deriveBits'] : ['sign']);
}

export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/* 페이로드를 aes128gcm으로 암호화해 요청 본문을 만듦.
   본문 = salt(16) || rs(4) || idlen(1) || 발신자공개키(65) || 암호문 */
export async function encryptPayload(
  payload: string,
  p256dhB64: string,
  authB64: string,
  opts?: { salt?: Uint8Array; asPrivate?: Uint8Array; asPublic?: Uint8Array },
): Promise<Uint8Array> {
  const uaPublic = b64u.decode(p256dhB64);
  const authSecret = b64u.decode(authB64);
  const salt = opts?.salt ?? crypto.getRandomValues(new Uint8Array(16));

  // 발신자(임시) 키쌍 — 테스트 벡터 검증 시에는 고정값을 주입받음
  let asPublic: Uint8Array, asPrivKey: CryptoKey;
  if (opts?.asPrivate && opts?.asPublic) {
    asPublic = opts.asPublic;
    asPrivKey = await importPrivateRaw(opts.asPrivate, opts.asPublic, 'ECDH');
  } else {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
    asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    asPrivKey = kp.privateKey;
  }

  // ECDH 공유 비밀
  const uaPubKey = await importPublicRaw(uaPublic);
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaPubKey }, asPrivKey, 256),
  );

  // RFC 8291 3.4: IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info\0"||ua_pub||as_pub, 32)
  const keyInfo = concat(utf8('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);

  // CEK / nonce
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);

  // 패딩 구분자 0x02(마지막 레코드) 추가 후 AES-128-GCM
  const plaintext = concat(utf8(payload), new Uint8Array([0x02]));
  const aesKey = await crypto.subtle.importKey('raw', cek as BufferSource, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource, tagLength: 128 }, aesKey, plaintext as BufferSource),
  );

  // 헤더: salt(16) || record size(4, big-endian) || idlen(1) || as_public(65)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

/* VAPID JWT (ES256) — Authorization: vapid t=<jwt>, k=<공개키> */
export async function vapidHeader(
  endpoint: string,
  subject: string,
  publicKeyB64: string,
  privateKeyB64: string,
  nowSec?: number,
): Promise<string> {
  const aud = new URL(endpoint).origin;
  const exp = (nowSec ?? Math.floor(Date.now() / 1000)) + 12 * 60 * 60; // 12시간 (상한 24시간)
  const header = b64u.encode(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u.encode(utf8(JSON.stringify({ aud, exp, sub: subject })));
  const signingInput = utf8(`${header}.${body}`);

  const pub = b64u.decode(publicKeyB64);
  const priv = b64u.decode(privateKeyB64);
  const key = await importPrivateRaw(priv, pub, 'ECDSA');
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, signingInput as BufferSource),
  );
  const jwt = `${header}.${body}.${b64u.encode(sig)}`;
  return `vapid t=${jwt}, k=${publicKeyB64}`;
}

export interface SendResult { ok: boolean; status: number; gone: boolean; }

/* 실제 발송. 404/410은 구독이 사라진 것이므로 gone=true로 알려 정리하게 함. */
export async function sendPush(
  sub: PushSubscription,
  payload: string,
  vapid: { subject: string; publicKey: string; privateKey: string },
  ttl = 3600,
): Promise<SendResult> {
  const bodyBytes = await encryptPayload(payload, sub.keys.p256dh, sub.keys.auth);
  const auth = await vapidHeader(sub.endpoint, vapid.subject, vapid.publicKey, vapid.privateKey);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'TTL': String(ttl),
      'Urgency': 'high',
      'Authorization': auth,
    },
    body: bodyBytes as BodyInit,
  });
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}
