/* AI 입력창 — 자연어를 작업판 조작 명령으로 바꾼 결과(ops)를 "미리보기 계획"으로 풀고, 사용자가
   [반영]을 누른 뒤에만 실제 데이터(S)에 적용하는 순수 함수 모음.
   - 네트워크·DOM 없음. index.html이 window.AiCommands로 쓰고 ai-commands.test.cjs가 node:test로 검증함.
   - AI(Claude)는 ops(JSON)만 만들고, 어떤 건을 고칠지·어떤 값을 채울지는 전부 여기서 기존 작업판 규칙
     (matchItem·locOf·leadOf·csApplyMark 등 helpers)로 다시 확정함. AI 출력은 "제안"이고 여기서 검증한
     계획만 화면에 보이며, 애매하면(대상 2건 이상·품목 못 찾음) 사람이 고르기 전까지 반영 불가로 둠.

   ops 한 건의 모양(서버 ask-board가 같은 스키마로 받음 — 바꾸면 supabase/functions/ask-board/index.ts도 함께):
     {type, id, item, vendor, consignee, dept, qty, unit, loc, date, note, text, mark}
     type: add_move | add_order | mark_in | edit_order | edit_cons | mark_cons | add_note
     쓰지 않는 칸은 null. date는 YYYY-MM-DD(mark_in: 입고일, add_order·edit_order: 입고예정일, edit_cons: 요청납기). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./ui-helpers.js'));
  else root.AiCommands = factory(root.UiHelpers);   // index.html은 ui-helpers.js를 먼저 읽음
})(typeof globalThis !== 'undefined' ? globalThis : this, function (UiHelpers) {
  'use strict';

  const OP_TYPES = ['add_move', 'add_order', 'mark_in', 'edit_order', 'edit_cons', 'mark_cons', 'add_note'];
  const MOVE_DEPTS = ['경질', '창호', '타일', 'DBP', '기타'];
  const MOVE_UNITS = ['kg', 'Bag', '드럼', 'PLT', 'Box', '대'];
  const ORDER_UNITS = ['kg', 'Bag', '드럼', '대', 'PLT'];
  const CONS_UNITS = ['kg', '톤', 'L', 'EA', '포', 'BOX', '롤', '드럼', 'PLT', 'm'];
  const CONS_MARKS = ['outDate', 'ordDate', 'done'];
  const CONS_MARK_LABEL = { outDate: '출고 완료', ordDate: '공급사 발주 완료', done: '완료' };
  const OP_LABEL = { add_move: '창고이동 등록', add_order: '발주 등록', mark_in: '입고 처리', edit_order: '발주 수정', edit_cons: '사급 수정', mark_cons: '사급 처리', add_note: '메모 추가' };
  const MAX_TEXT = 300;

  const str = v => (v == null ? '' : String(v)).trim();
  const num = v => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
  const isoDate = v => { const d = str(v); if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return ''; const x = new Date(d + 'T00:00:00'); return isNaN(x) || localISO(x) !== d ? '' : d; };   // 2026-13-45 같은 값은 버림
  const pad2 = n => String(n).padStart(2, '0');
  const localISO = x => `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`;
  const fmtQ = (q, u) => (q == null || q === '' ? '' : `${Number(q).toLocaleString('ko-KR')} ${u || ''}`.trim());
  const pickUnit = (u, list, dflt) => { const s = str(u); const hit = list.find(x => x.toLowerCase() === s.toLowerCase()); return hit || dflt; };

  /* AI에 보낼 작업판 요약 — 품목·사급처·매입처 이름과 "열려 있는" 발주·사급 건(id 포함).
     id를 같이 주면 AI가 대상을 id로 가리킬 수 있어 같은 품목이 여러 건일 때 덜 헷갈림. 닫힌 건(입고·완료)은
     보내지 않음(수정 대상도 아니고 토큰만 늘어남). */
  function buildContext({ S, materials, consignees, vendors, today }) {
    const s = S || {};
    const openOrders = (s.orders || []).filter(o => o && !o.skip && !o.inDate)
      .map(o => ({ id: o.id, type: o.type, item: o.item, vendor: o.vendor || '', dest: o.dest || '', qty: o.qty, unit: o.unit || '', eta: o.eta || '' }));
    const openCons = (s.cons || []).filter(c => c && !c.done)
      .map(c => ({ id: c.id, consignee: c.consignee || '', item: c.item, qty: c.qty, unit: c.unit || '', due: c.due || '', action: c.action || '', ordDate: c.ordDate || '', outDate: c.outDate || '' }));
    const uniq = a => [...new Set((a || []).map(str).filter(Boolean))];
    return {
      today: str(today),
      depts: MOVE_DEPTS,
      units: { move: MOVE_UNITS, order: ORDER_UNITS, cons: CONS_UNITS },
      items: uniq(materials),
      consignees: uniq([...(consignees || []), ...openCons.map(c => c.consignee)]),
      vendors: uniq(vendors),
      openOrders, openCons,
    };
  }

  /* 서버가 돌려준 ops를 느슨하게 정리 — 모르는 type·빈 항목은 버리고 칸을 정규화. 10건 초과는 잘라 사고 범위를 좁힘. */
  function normalizeOps(raw) {
    const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.ops) ? raw.ops : []);
    return list.filter(o => o && typeof o === 'object' && OP_TYPES.includes(o.type)).slice(0, 10).map(o => ({
      type: o.type, id: num(o.id), item: str(o.item), vendor: str(o.vendor), consignee: str(o.consignee), dept: str(o.dept),
      qty: num(o.qty), unit: str(o.unit), loc: str(o.loc), date: isoDate(o.date), note: str(o.note), text: str(o.text).slice(0, MAX_TEXT), mark: str(o.mark),
    }));
  }

  /* 대상 후보 찾기 — id가 맞으면 그 건, 아니면 품목(+업체/사급처)으로 열린 건을 모음.
     품목은 정확히 같은 키를 먼저 찾고, 없을 때만 부분 일치(P-1000 ↔ SP-1000 같은 포함 관계)로 넓힘.
     부분 일치로 찾은 건은 exact:false — 1건뿐이어도 사람이 고르기 전에는 반영하지 않음. */
  function findTargets(list, op, h, who) {
    const live = list.filter(x => x && (who === 'orders' ? !x.skip && !x.inDate : !x.done));
    if (op.id != null) { const hit = live.find(x => x.id === op.id); if (hit) return { list: [hit], exact: true }; }
    if (!op.item) return { list: [], exact: true };
    const keys = h.itemKeys(op.item);
    const exactItem = x => h.itemKeys(x.item).some(k => keys.includes(k));
    const nearItem = x => { const ks = h.itemKeys(x.item); return keys.some(k => ks.some(kk => kk.includes(k) || k.includes(kk))); };
    let c = live.filter(exactItem), exact = true;
    if (!c.length) { c = live.filter(nearItem); exact = false; }
    // 업체·사급처를 적었으면 그 조건에 맞는 건만 — 맞는 게 없으면 "없음"으로(다른 업체 건을 대신 고르지 않음)
    const partner = who === 'orders' ? op.vendor : op.consignee;
    if (partner) { const pn = h.norm(partner); c = c.filter(x => { const xn = h.norm(who === 'orders' ? x.vendor : x.consignee); return xn && (xn.includes(pn) || pn.includes(xn)); }); }
    // 수량을 적었으면 같은 수량 건으로 좁힘 — 맞는 수량이 없으면 후보는 두되 사람이 고르게(exact:false)
    if (c.length && op.qty != null) { const c3 = c.filter(x => Number(x.qty) === op.qty); if (c3.length) c = c3; else exact = false; }
    return { list: c, exact };
  }
  const orderDesc = o => `${o.item} · ${o.vendor || o.dest || ''} · ${fmtQ(o.qty, o.unit)}${o.eta ? ' · 착일 ' + o.eta : ''}`.replace(/ · (?= ·| $)/g, '');
  const consDesc = c => `${c.consignee} · ${c.item} · ${fmtQ(c.qty, c.unit)}${c.due ? ' · 납기 ' + c.due : ''}${c.action ? ' · ' + c.action : ''}`;

  /* ops → 미리보기 계획. 각 항목: {op, label, desc, ok, reason, target(id), candidates[{id,desc}], before, after, create}
     helpers(h): itemKeys, norm, matchItem, locOf, leadOf, deptOf, ropOf, addDays, isM210 — index.html의 기존 함수를 그대로 넘김. */
  function planOps(ops, { S, today, helpers: h }) {
    const s = S || { orders: [], cons: [], moves: [], notes: [] };
    return normalizeOps(ops).map(op => {
      const p = { op, label: OP_LABEL[op.type], desc: '', ok: false, reason: '', target: null, candidates: [], before: null, after: null, create: null };
      const needTarget = (list, who) => {
        const { list: c, exact } = findTargets(list, op, h, who);
        const d = who === 'orders' ? orderDesc : consDesc;
        if (!c.length) { p.reason = op.item ? `열려 있는 ${who === 'orders' ? '발주' : '사급'} 건 중 '${op.item}'을 찾지 못함` : '대상을 지정하지 않음'; return null; }
        p.candidates = c.map(x => ({ id: x.id, desc: d(x) }));
        if (c.length > 1) { p.reason = `대상 ${c.length}건 — 아래에서 1건을 고르세요`; return null; }
        if (!exact) { p.reason = `'${op.item}'${op.qty != null ? ` ${fmtQ(op.qty, op.unit)}` : ''}과 정확히 맞는 건이 없어 비슷한 건을 찾음 — 맞으면 아래에서 고르세요`; return null; }
        p.target = c[0].id; return c[0];
      };
      switch (op.type) {
        case 'add_move': {
          if (!op.item) { p.reason = '품목이 없음'; break; }
          if (!(op.qty > 0)) { p.reason = '수량이 없음'; break; }
          const m = h.matchItem(op.item);
          const item = m ? m.name : op.item;
          const dept = MOVE_DEPTS.includes(op.dept) ? op.dept : (m && MOVE_DEPTS.includes(h.deptOf(m)) ? h.deptOf(m) : '');
          if (!dept) { p.reason = '부서(경질·창호·타일·DBP)를 알 수 없음 — 부서를 함께 적어 주세요'; break; }
          const unit = pickUnit(op.unit, MOVE_UNITS, 'kg');
          p.create = { kind: 'moves', row: { date: today, dept, item, qty: op.qty, unit, loc: op.loc || h.locOf(item), note: op.note || 'AI 입력', done: false } };
          p.desc = `${dept} · ${item} · ${fmtQ(op.qty, unit)} · 출고창고 ${p.create.row.loc || '(미정)'}${m ? '' : ' · 신규 품목'}`;
          p.ok = true; break;
        }
        case 'add_order': {
          if (!op.item) { p.reason = '품목이 없음'; break; }
          if (!(op.qty > 0)) { p.reason = '수량이 없음'; break; }
          const m = h.matchItem(op.item);
          const item = m ? m.name : op.item;
          const rp = h.ropOf(item);
          const vendor = op.vendor || (rp && rp.vendor) || (m && !/확인/.test(m.vendor || '') ? m.vendor : '') || '';
          const unit = pickUnit(op.unit, ORDER_UNITS, 'kg');
          const eta = op.date || h.addDays(today, h.leadOf(item));
          p.create = { kind: 'orders', row: { type: 'self', ordDate: today, vendor, item, dest: '자가(세종·부강)', qty: op.qty, unit, eta, inDate: '', loc: h.locOf(item), dept: m ? h.deptOf(m) : '전사', note: op.note || 'AI 입력' } };
          p.desc = `${item} · ${vendor || '매입처 미정'} · ${fmtQ(op.qty, unit)} · 착일 ${eta}${m ? '' : ' · 신규 품목'}`;
          p.ok = true; break;
        }
        case 'mark_in': {
          const o = needTarget(s.orders, 'orders'); if (!o) break;
          const d = op.date || today;
          p.before = { inDate: o.inDate || '' }; p.after = { inDate: d };
          p.desc = `${orderDesc(o)} → 입고 완료 (${d})`; p.ok = true; break;
        }
        case 'edit_order': {
          const o = needTarget(s.orders, 'orders'); if (!o) break;
          const after = {};
          if (op.date) after.eta = op.date;
          if (op.qty != null && op.qty > 0) after.qty = op.qty;
          const ou = pickUnit(op.unit, ORDER_UNITS, ''); if (ou) after.unit = ou;
          if (op.note) after.note = op.note;   // 업체(vendor)는 대상을 찾는 조건으로만 쓰고 바꾸지 않음 — 매입처 변경은 수정 창에서
          if (!Object.keys(after).length) { p.reason = '바꿀 내용이 없음(입고예정일·수량·단위·비고 중 하나)'; break; }
          p.before = Object.fromEntries(Object.keys(after).map(k => [k, o[k] ?? ''])); p.after = after;
          p.desc = `${orderDesc(o)} → ${describeChange(p.before, after, { eta: '착일', qty: '수량', unit: '단위', note: '비고' })}`;
          p.ok = true; break;
        }
        case 'edit_cons': {
          const c = needTarget(s.cons, 'cons'); if (!c) break;
          const after = {};
          if (op.date) after.due = op.date;
          if (op.qty != null && op.qty > 0) after.qty = op.qty;
          const cu = pickUnit(op.unit, CONS_UNITS, ''); if (cu) after.unit = cu;
          if (op.note) after.note = op.note;
          if (!Object.keys(after).length) { p.reason = '바꿀 내용이 없음(요청납기·수량·단위·비고 중 하나)'; break; }
          p.before = Object.fromEntries(Object.keys(after).map(k => [k, c[k] ?? ''])); p.after = after;
          p.desc = `${consDesc(c)} → ${describeChange(p.before, after, { due: '요청납기', qty: '수량', unit: '단위', note: '비고' })}`;
          p.ok = true; break;
        }
        case 'mark_cons': {
          if (!CONS_MARKS.includes(op.mark)) { p.reason = '처리 종류(출고 완료·공급사 발주 완료·완료)를 알 수 없음'; break; }
          const c = needTarget(s.cons, 'cons'); if (!c) break;
          if ((op.mark === 'outDate' || op.mark === 'done') && h.isM210(c.item) && !c.m210by) {
            p.reason = 'M-210(월1회 입항분)은 행선지 확인이 필요 — 사급 탭에서 직접 처리하세요'; p.candidates = []; break;
          }
          if (op.mark === 'outDate' && c.outDate) { p.reason = `이미 출고 완료(${c.outDate})`; break; }
          if (op.mark === 'ordDate' && c.ordDate) { p.reason = `이미 공급사 발주 완료(${c.ordDate})`; break; }
          p.after = { mark: op.mark };
          p.desc = `${consDesc(c)} → ${op.mark === 'done' && c.action === '발주' ? '입고 완료' : CONS_MARK_LABEL[op.mark]}`;
          p.ok = true; break;
        }
        case 'add_note': {
          if (!op.text) { p.reason = '메모 내용이 없음'; break; }
          p.create = { kind: 'notes', row: { date: today, text: op.text, done: false, doneBy: '' } };
          p.desc = op.text; p.ok = true; break;
        }
      }
      return p;
    });
  }
  function describeChange(before, after, labels) {
    return Object.keys(after).map(k => `${labels[k] || k} ${before[k] === '' || before[k] == null ? '(빈칸)' : before[k]} → ${after[k]}`).join(', ');
  }

  /* 계획 중 ok인 항목만 S에 적용. 되돌리기용 변경 기록을 돌려줌: [{kind,id,fields}] (수정) / [{kind,id,created:true}] (등록).
     who: 입고·출고 처리자 이름(whoNow). noteBy: 메모 등록자(addNote와 같은 값 — 이름 미입력이면 '').
     csApplyMark: index.html의 사급 처리 규칙 함수(중복 구현하지 않음). */
  function applyPlan(plan, { S, today, who, noteBy, csApplyMark }) {
    const changes = [];
    let applied = 0;
    for (const p of plan) {
      if (!p || !p.ok) continue;
      const op = p.op;
      if (p.create) {
        const row = { id: S.seq++, ...p.create.row };
        if (p.create.kind === 'notes') row.by = noteBy || '';
        S[p.create.kind] = S[p.create.kind] || [];
        S[p.create.kind].push(row);
        changes.push({ kind: p.create.kind, id: row.id, created: true }); applied++; continue;
      }
      const kind = (op.type === 'mark_in' || op.type === 'edit_order') ? 'orders' : 'cons';
      const x = (S[kind] || []).find(r => r.id === p.target);
      if (!x) continue;   // 미리보기 뒤에 다른 기기에서 지워진 건 — 조용히 건너뜀(반영 건수에서 빠짐)
      if (op.type === 'mark_cons') {
        const fields = ['done', 'inDate', 'outDate', 'ordDate', 'outBy'];
        changes.push({ kind, id: x.id, fields: UiHelpers.snapshot(x, fields) });
        csApplyMark(x, p.after.mark);
      } else {
        const keys = Object.keys(p.after);
        changes.push({ kind, id: x.id, fields: UiHelpers.snapshot(x, op.type === 'mark_in' ? ['inDate', 'inBy'] : keys) });
        Object.assign(x, p.after);
        if (op.type === 'mark_in') x.inBy = who || '';
      }
      applied++;
    }
    return { applied, changes };
  }

  /* applyPlan이 돌려준 변경 기록으로 되돌림. 등록 건(메모 포함)은 호출자가 넘긴 toTrash로 휴지통에 보관하고 목록에서
     제외, 수정 건은 저장해 둔 칸만 원래 값으로. 돌려준 n이 0이면 되돌릴 대상이 이미 없음(다른 기기에서 지움 등). */
  function undoChanges(changes, { S, toTrash }) {
    let n = 0;
    const byKind = {};
    for (const ch of changes) {
      if (ch.created) { (byKind[ch.kind] = byKind[ch.kind] || []).push(ch.id); continue; }
      const x = (S[ch.kind] || []).find(r => r.id === ch.id); if (!x) continue;
      UiHelpers.restore(x, ch.fields); n++;
    }
    for (const [kind, ids] of Object.entries(byKind)) {
      const gone = (S[kind] || []).filter(r => ids.includes(r.id));
      if (!gone.length) continue;
      if (toTrash) toTrash(kind, gone);
      S[kind] = S[kind].filter(r => !ids.includes(r.id)); n += gone.length;
    }
    return n;
  }

  /* ───────── 규칙 기반 해석(무료, 서버 불필요) ─────────
     정해진 어순을 정규식·사전으로 읽어 AI와 같은 모양의 ops를 만듦. AI(ask-board)는 서버에 설정돼 있을 때만
     이 해석이 실패한 문장에 한해 선택적으로 쓰임. 알아듣는 어순(한 줄에 여러 지시는 줄바꿈·';'·' / '로 구분):
       [부서] 품목 수량[단위] 이동|이동요청|가져다        → add_move   (예: 경질 P-1000 2톤 이동)
       품목 수량[단위] 발주 [착일 10/20]                   → add_order  (예: TIONA-696 백 10톤 발주)
       품목 [업체] 입고|입고완료|입고 처리 [10/11]          → mark_in    (예: P-1000 발주 입고)
       사급처 품목 출고완료|발주완료|완료                   → mark_cons  (예: 대양물산 SP-390 출고 완료)
       품목|사급처 품목 (요청)납기|착일|입고예정 10/20[으로] → edit_cons / edit_order
       품목|사급처 품목 수량 500[kg]으로                    → edit_cons / edit_order
       메모: 내용  /  메모 내용                             → add_note
     "2톤"은 kg로 환산, 날짜는 M/D·M월 D일·YYYY-MM-DD·오늘·내일·모레. 사급처 이름이나 "사급"이 있으면 사급 건으로 봄. */
  const DEPT_ALIAS = { '경질': '경질', '창호': '창호', '타일': '타일', '디럭스': '타일', 'DBP': 'DBP', '데코': 'DBP', '장판': 'DBP', '벽지': 'DBP', '기타': '기타' };
  const UNIT_ALIAS = { '톤': 'ton', 't': 'ton', 'ton': 'ton', 'kg': 'kg', '킬로': 'kg', '키로': 'kg', 'bag': 'Bag', '백': 'Bag', '포': 'Bag', '드럼': '드럼', 'plt': 'PLT', '파레트': 'PLT', '팔레트': 'PLT', '빠레트': 'PLT', 'box': 'Box', '박스': 'Box', '대': '대', '롤': '롤', 'ea': 'EA', 'l': 'L' };
  const UNIT_RE = '톤|ton|kg|킬로|키로|bag|백|포|드럼|plt|파레트|팔레트|빠레트|box|박스|대|롤|ea|l|t';
  const QTY_RE = new RegExp(`(?:^|[\\s,])(\\d[\\d,]*(?:\\.\\d+)?)\\s*(${UNIT_RE})?(?=$|[\\s,]|으로|로)`, 'i');
  const SPLIT_RE = /\n|;|\s\/\s|\s·\s/;
  function parseDate(text, today) {
    // 상대 표현
    if (/오늘/.test(text)) return { date: today, matched: '오늘' };
    if (/내일/.test(text)) return { date: addDaysISO(today, 1), matched: '내일' };
    if (/모레/.test(text)) return { date: addDaysISO(today, 2), matched: '모레' };
    let m = text.match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
    if (m) return { date: `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`, matched: m[0] };
    m = text.match(/(?:^|[^\d])(\d{1,2})\s*\/\s*(\d{1,2})(?!\d)/) || text.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일?/);   // M.D는 1.5톤과 겹쳐 받지 않음
    if (!m) return null;
    const mo = +m[1], d = +m[2];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    let y = +today.slice(0, 4);
    const cand = `${y}-${pad2(mo)}-${pad2(d)}`;
    // 연도 없이 적은 날짜가 반년 넘게 과거면 내년으로(연말에 1월 납기를 적는 경우)
    if (diffDaysISO(cand, today) < -180) y++;
    return { date: `${y}-${pad2(mo)}-${pad2(d)}`, matched: m[0].replace(/^[^\d]/, '') };
  }
  function addDaysISO(d, n) { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return localISO(x); }
  function diffDaysISO(a, b) { return Math.round((new Date(a + 'T00:00:00') - new Date(b + 'T00:00:00')) / 86400000); }

  /* 문장 안에서 사전(items·consignees) 항목 찾기 — 띄어쓰기·하이픈·괄호 차이는 norm으로 무시.
     토큰 1~3개를 이어 본 것 중 정확히 같은 항목을 우선, 없으면 토큰(3자 이상)을 포함하는 항목 중 가장 짧은 것. */
  function findInDict(tokens, dict, h, minLen) {
    const normed = dict.map(name => ({ name, k: h.norm(name) })).filter(x => x.k);
    let best = null;
    for (let n = Math.min(3, tokens.length); n >= 1; n--) {
      for (let i = 0; i + n <= tokens.length; i++) {
        const span = tokens.slice(i, i + n).join('');
        const k = h.norm(span); if (k.length < minLen) continue;
        const exact = normed.find(x => x.k === k);
        if (exact) return { name: exact.name, from: i, to: i + n };
        if (!best) {
          const part = normed.filter(x => x.k.includes(k) || (k.length >= 4 && k.includes(x.k))).sort((a, b) => a.k.length - b.k.length)[0];
          if (part && n === 1) best = { name: part.name, from: i, to: i + n, partial: true };
        }
      }
    }
    return best;
  }

  function parseOne(line, ctx, h) {
    let text = line.trim(); if (!text) return null;
    const today = ctx.today;
    // 메모
    const memo = text.match(/^(?:메모|전달|전달사항)\s*[:：]?\s*(.+)$/);
    if (memo) return { type: 'add_note', text: memo[1].trim() };

    // 수량·날짜는 먼저 떼어내 품목 코드(P-1000) 숫자와 섞이지 않게 함. 수량을 먼저 떼야 "1.5톤"이 1월 5일로 읽히지 않음.
    const isEditDate = /납기|착일|입고예정|예정일|예정/.test(text);
    const isEditQty = /수량/.test(text) || /(\d)\s*(?:kg|톤)?\s*(?:으로|로)(?=\s|$)/i.test(text);
    let qty = null, unit = '';
    // 수량: 품목 토큰(P-1000 같은 코드)을 피하려고 "숫자 단위" 꼴 또는 공백으로 분리된 숫자만 봄
    const tokens0 = text.split(/\s+/).filter(Boolean);
    const items0 = findInDict(tokens0, ctx.items || [], h, 3);
    const noItem = items0 ? tokens0.filter((_, i) => i < items0.from || i >= items0.to).join(' ') : text;
    const qm = noItem.match(QTY_RE);
    if (qm) {
      qty = parseFloat(qm[1].replace(/,/g, ''));
      const u = (qm[2] || '').toLowerCase();
      unit = UNIT_ALIAS[u] || UNIT_ALIAS[qm[2]] || '';
      if (unit === 'ton') { qty = qty * 1000; unit = 'kg'; }
      text = text.replace(qm[0], ' ');
    }
    const dt = parseDate(text, today);
    if (dt) text = text.replace(dt.matched, ' ');
    text = text.replace(/(으로|로)(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();

    // 동작 키워드 (뒤에서부터 찍는 게 보통이라 전체에서 찾되 우선순위를 둠)
    const has = re => re.test(text);
    let action = null;
    if (has(/출고\s*완료|출고\s*처리|출고됨|출고$|나감/)) action = 'cons_out';
    else if (has(/(?:공급사|업체)?\s*발주\s*완료|발주\s*처리|발주됨|발주했/)) action = 'cons_ord';
    else if (has(/입고\s*완료|입고\s*처리|입고됨|입고$|입고(?=\s)|들어옴|들어왔/)) action = 'in';
    else if (has(/이동\s*요청|이동|가져다|가져와|옮겨|출고\s*요청/)) action = 'move';
    else if (has(/발주/)) action = 'order';
    else if (has(/완료|끝남|처리/)) action = 'done';
    if (!action && (isEditDate || isEditQty)) action = 'edit';
    if (!action) return null;

    // 수정 키워드가 있으면 등록 동작이 아니라 수정으로 봄 ("P-1000 발주 착일 10/20으로", "SP-390 납기 10/20").
    // 단 "P-1000 3000 발주 착일 10/20"처럼 수량이 함께 있는 발주는 착일을 지정한 신규 발주, 이동 등록은 그대로.
    if (isEditQty && qty != null && action !== 'move') action = 'edit';
    else if (isEditDate && dt && action !== 'move' && action !== 'in' && !(action === 'order' && qty != null)) action = 'edit';

    const strip = text.replace(/출고\s*완료|출고\s*처리|출고됨|발주\s*완료|발주\s*처리|발주됨|발주했|입고\s*완료|입고\s*처리|입고됨|들어옴|들어왔|이동\s*요청|출고\s*요청|이동|가져다\s*주세요|가져다|가져와|옮겨\s*주세요|옮겨|발주|입고|출고|완료|끝남|처리|수량|요청납기|납기|착일|입고예정일|입고예정|예정일|예정|수정|변경|공급사|업체|사급|건|을|를/g, ' ').replace(/\s+/g, ' ').trim();
    const tokens = strip.split(' ').filter(Boolean);
    const itemHit = findInDict(tokens, ctx.items || [], h, 3);
    const rest = tokens.filter((_, i) => !itemHit || i < itemHit.from || i >= itemHit.to);
    const consHit = findInDict(rest, ctx.consignees || [], h, 2);
    const rest2 = rest.filter((_, i) => !consHit || i < consHit.from || i >= consHit.to);
    const deptTok = rest2.find(t => DEPT_ALIAS[t]);
    const rest3 = rest2.filter(t => t !== deptTok);
    // 사급처 이름이 있으면 사급. 없으면 "사급"·"납기"(사급 요청납기)면 사급, "착일·입고예정"(발주 쪽 말)이면 발주
    const isCons = consHit ? true : (/사급|납기/.test(text) && !/착일|입고예정/.test(text));
    // 사전에 없는 품목: 남은 토큰 중 영숫자·하이픈 코드 꼴(P-1000, SP390) 또는 첫 토큰
    const codeTok = rest3.find(t => /^[A-Za-z]{1,6}-?\d{2,}[A-Za-z0-9-]*$/.test(t));
    const item = itemHit ? itemHit.name : (codeTok || rest3[0] || '');
    const rest4 = rest3.filter(t => t !== (itemHit ? null : (codeTok || rest3[0])));
    const partner = consHit ? consHit.name : (rest4[0] || '');
    const base = { id: null, item: item || null, vendor: null, consignee: null, dept: null, qty: null, unit: null, loc: null, date: null, note: null, text: null, mark: null };

    switch (action) {
      case 'move': return { ...base, type: 'add_move', dept: deptTok ? DEPT_ALIAS[deptTok] : null, qty, unit: unit || null };
      case 'order': return { ...base, type: 'add_order', qty, unit: unit || null, vendor: isCons ? null : (partner || null), date: dt ? dt.date : null };
      case 'in': return { ...base, type: 'mark_in', vendor: partner || null, qty: qty, date: dt ? dt.date : null };
      case 'cons_out': return { ...base, type: 'mark_cons', consignee: partner || null, qty, mark: 'outDate' };
      case 'cons_ord': return { ...base, type: 'mark_cons', consignee: partner || null, qty, mark: 'ordDate' };
      case 'done': return isCons ? { ...base, type: 'mark_cons', consignee: partner || null, qty, mark: 'done' } : { ...base, type: 'mark_in', vendor: partner || null, qty, date: dt ? dt.date : null };
      case 'edit': {
        const set = { date: dt ? dt.date : null, qty: isEditQty ? qty : null, unit: isEditQty && unit ? unit : null };
        if (!set.date && set.qty == null) return null;
        return isCons ? { ...base, type: 'edit_cons', consignee: partner || null, ...set }
                      : { ...base, type: 'edit_order', vendor: partner || null, ...set };
      }
    }
    return null;
  }

  /* 입력 전체 → {ops, message, unparsed[]}. ctx: buildContext() 결과(items·consignees·today), h: helpers(norm). */
  function parseLocal(input, ctx, h) {
    const lines = String(input || '').split(SPLIT_RE).map(x => x.trim()).filter(Boolean);
    const ops = [], unparsed = [];
    for (const line of lines) { const op = parseOne(line, ctx, h); if (op) ops.push(op); else unparsed.push(line); }
    let message = '';
    if (!lines.length) message = '지시 내용을 입력하세요';
    else if (!ops.length) message = '어순을 알아듣지 못했습니다 — 예) 경질 P-1000 2톤 이동 · 대양물산 SP-390 출고 완료 · P-1000 발주 입고 · 메모: 내용';
    else if (unparsed.length) message = `${ops.length}건 해석 · 알아듣지 못한 줄: ${unparsed.join(' / ')}`;
    else message = `${ops.length}건 해석했습니다 — 아래 미리보기를 확인하세요`;
    return { ops, message, unparsed };
  }

  return { OP_TYPES, MOVE_DEPTS, MOVE_UNITS, ORDER_UNITS, CONS_UNITS, CONS_MARKS, OP_LABEL, buildContext, normalizeOps, planOps, applyPlan, undoChanges, parseLocal, parseDate };
});
