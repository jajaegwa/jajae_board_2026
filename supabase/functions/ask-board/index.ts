/* 작업판 AI 입력창 중계 Edge Function
   자연어 한 줄("경질 P-1000 2톤 이동")을 받아 Claude에게 작업판 조작 명령(ops, JSON)으로 바꿔 달라고 하고
   그 JSON을 그대로 돌려줌. 데이터는 여기서 바꾸지 않음 — 작업판(ai-commands.js)이 미리보기를 만들고
   사용자가 [반영]을 눌러야 저장됨.

   API 키가 브라우저에 내려가지 않게 하는 것이 이 함수의 목적. 작업판은 부서 공유 비밀번호로 호출함.

   필요한 시크릿 (Supabase 대시보드 > Edge Functions > Secrets — 프로젝트 공통)
     ANTHROPIC_API_KEY  Claude API 키            ← 절대 저장소에 올리지 말 것
     BOARD_PASSCODE     작업판 공유 비밀번호     (notify-drivers와 같은 값 — 이미 있으면 다시 넣지 않아도 됨)
     AI_MODEL           (선택) 모델명. 기본 claude-opus-5-5. 비용을 낮추려면 claude-haiku-5-5

   엔드포인트
     GET  ?config=1                         → { configured, model }
     POST { passcode, text, context }       → { ops:[...], message, model, usage }
       context: ai-commands.js buildContext()가 만든 작업판 요약(품목·사급처·열린 발주/사급 건) */

import Anthropic from 'npm:@anthropic-ai/sdk@^0.110.0';

const API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const BOARD_PASSCODE = Deno.env.get('BOARD_PASSCODE') ?? '';
const MODEL = Deno.env.get('AI_MODEL') || 'claude-opus-5-5';
const MAX_TEXT = 500;            // 입력 한 줄 상한(글자)
const MAX_CONTEXT = 120_000;     // 작업판 요약 상한(문자) — 비정상 호출 방지

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

/* 길이 정보까지 흘리지 않는 비교 — 비밀번호 대조용 (notify-drivers와 동일) */
function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

/* ops 한 건의 스키마 — ai-commands.js normalizeOps()가 받는 모양과 같아야 함. 쓰지 않는 칸은 null.
   구조화 출력(output_config.format)이라 Claude 응답은 항상 이 모양의 JSON으로 옴. */
const nullable = (t: string) => ({ type: [t, 'null'] });
const OP_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['add_move', 'add_order', 'mark_in', 'edit_order', 'edit_cons', 'mark_cons', 'add_note'] },
    id: nullable('integer'),
    item: nullable('string'), vendor: nullable('string'), consignee: nullable('string'), dept: nullable('string'),
    qty: nullable('number'), unit: nullable('string'), loc: nullable('string'),
    date: nullable('string'), note: nullable('string'), text: nullable('string'),
    mark: { type: ['string', 'null'], enum: ['outDate', 'ordDate', 'done', null] },
  },
  required: ['type', 'id', 'item', 'vendor', 'consignee', 'dept', 'qty', 'unit', 'loc', 'date', 'note', 'text', 'mark'],
  additionalProperties: false,
};
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ops: { type: 'array', items: OP_SCHEMA },
    message: { type: 'string' },
  },
  required: ['ops', 'message'],
  additionalProperties: false,
};

/* 고정 지시문 — 요청마다 같아서 프롬프트 캐시가 걸림. 작업판 요약(매번 다름)은 user 메시지에 넣음. */
const SYSTEM = `당신은 한국 제조업 자재과의 "작업판" 입력 도우미입니다. 담당자가 한 줄로 적은 업무 지시를 작업판 조작 명령(ops)으로 바꿉니다.
명령은 실제로 실행되지 않고 담당자가 미리보기로 확인한 뒤 반영하므로, 가장 그럴듯한 해석 1개를 내되 확신이 없으면 ops를 비우고 message에 짧은 질문을 적으세요.

명령 종류(type)와 쓰는 칸:
- add_move  창고→라인 이동 요청 등록: dept(경질·창호·타일·DBP·기타 중 하나), item, qty, unit(kg·Bag·드럼·PLT·Box·대), loc(출고창고, 모르면 null), note
- add_order 자가 발주(우리 공장 입고) 등록: item, qty, unit(kg·Bag·드럼·대·PLT), vendor(매입처, 모르면 null), date(입고예정일, 없으면 null), note
- mark_in   발주 건 입고 완료: id(열린 발주 목록의 id) 또는 item(+vendor), date(실입고일, 오늘이면 null)
- edit_order 발주 건 수정: id 또는 item(+vendor), 바꿀 값만 date(입고예정일)·qty·unit·note
- edit_cons 사급 건 수정: id 또는 item(+consignee), 바꿀 값만 date(요청납기)·qty·unit·note
- mark_cons 사급 건 처리: id 또는 item(+consignee), mark = outDate(출고 완료) | ordDate(공급사 발주 완료) | done(완료)
- add_note  자유 메모(지게차 기사에게도 보임): text

규칙:
- 날짜는 YYYY-MM-DD. "내일·다음 주 월요일·10/20"은 context.today 기준으로 환산. 연도가 없으면 올해(이미 지난 날짜면 내년).
- 수량: "2톤"은 kg 단위로 2000. "1대"는 unit "대". 단위를 말하지 않으면 kg. "500"처럼 숫자만 있으면 qty 500, unit null.
- 품목·사급처·매입처는 context의 목록에서 가장 가까운 표기를 그대로 쓰세요(띄어쓰기·대소문자·하이픈이 조금 달라도 목록 표기로). 목록에 없으면 입력 그대로.
- 발주·사급 건을 가리킬 때는 context.openOrders / openCons에서 맞는 건의 id를 넣으세요. 같은 품목이 여러 건이고 어느 건인지 알 수 없으면 id는 null로 두고 item만 적으세요(화면에서 고르게 됨).
- "입고"는 발주 건(mark_in), "출고·발주완료·완료"는 사급 건(mark_cons)입니다. "사급" 또는 사급처 이름이 있으면 사급 건입니다.
- 한 줄에 여러 지시가 있으면 ops를 여러 개 만드세요(최대 10개).
- 삭제·취소·기준정보 변경은 지원하지 않습니다. 그런 요청이면 ops를 비우고 message에 "작업판에서 직접 처리해 주세요"라고 적으세요.
- message는 한 문장(한국어). ops가 있으면 무엇을 할지 요약, 없으면 이유나 질문.
- 쓰지 않는 칸은 모두 null로 채우세요.`;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const url = new URL(req.url);
  if (req.method === 'GET' || url.searchParams.has('config')) {
    return json({ configured: !!API_KEY, model: MODEL });
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'bad json' }, 400);

  // 작업판 비밀번호를 아는 기기만 허용 — 키 사용량을 아무나 쓰지 못하게
  if (!BOARD_PASSCODE || !safeEqual(String(body.passcode ?? ''), BOARD_PASSCODE)) {
    return json({ error: 'unauthorized' }, 401);
  }
  if (!API_KEY) return json({ error: 'not configured', detail: 'ANTHROPIC_API_KEY 시크릿이 없습니다' }, 503);

  const text = String(body.text ?? '').trim();
  if (!text) return json({ error: 'empty' }, 400);
  if (text.length > MAX_TEXT) return json({ error: 'too long', detail: `입력은 ${MAX_TEXT}자 이내` }, 400);
  const context = JSON.stringify(body.context ?? {});
  if (context.length > MAX_CONTEXT) return json({ error: 'context too large' }, 413);

  const client = new Anthropic({ apiKey: API_KEY });
  try {
    const res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,   // 생각(thinking) 토큰도 여기에 포함되므로 넉넉히 — 잘리면 아래서 오류로 돌려줌
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `context:\n${context}\n\n입력:\n${text}` }],
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
      // 안전 분류기가 거절하면 같은 요청을 다른 모델로 이어 받음(거절 범주별 기본 경로)
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    if (res.stop_reason === 'max_tokens') return json({ error: 'truncated', detail: '응답이 잘렸습니다 — 지시를 나눠서 다시 입력' }, 502);
    if (res.stop_reason === 'refusal') {
      return json({ ops: [], message: '이 입력은 처리할 수 없습니다. 다르게 적어 주세요.', model: res.model, usage: res.usage });
    }
    const textBlock = res.content.find(b => b.type === 'text');
    let out: { ops?: unknown[]; message?: string } = {};
    try { out = JSON.parse(textBlock && textBlock.type === 'text' ? textBlock.text : '{}'); } catch { out = {}; }
    return json({
      ops: Array.isArray(out.ops) ? out.ops : [],
      message: String(out.message ?? ''),
      model: res.model,
      usage: { input: res.usage.input_tokens, output: res.usage.output_tokens, cached: res.usage.cache_read_input_tokens ?? 0 },
    });
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 401) return json({ error: 'api key', detail: 'Claude API 키가 올바르지 않습니다' }, 502);
    if (status === 429) return json({ error: 'rate limit', detail: '요청이 많습니다 — 잠시 후 다시 시도' }, 502);
    return json({ error: 'api', detail: String((e as Error).message ?? e).slice(0, 300) }, 502);
  }
});
