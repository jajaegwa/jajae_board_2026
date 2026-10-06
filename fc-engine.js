/* 재고 소진 예측 엔진 — 순수 함수 모음(DOM·네트워크·S 변경 없음).
   index.html이 window.FcEngine으로 쓰고, fc-engine.test.cjs가 node:test로 검증함.

   흐름: 날짜별 재고 스냅샷 + 입고 기록 → 일 소비량 시계열 → 모델 선택(이동평균·지수평활·추세)
        → 일 소비 예측·변동성(σ) → 안전재고·동적 발주점·소진 예상 범위·리스크·권장 발주량.

   용어
   - rate   : 하루 소비량 예측(kg/일)
   - sigma  : 하루 소비량의 표준편차(모델 잔차 기준). 변동성이 클수록 안전재고가 커짐
   - lt     : 리드타임(일), review: 발주 검토 주기(일) — 발주 주기 기준표의 주기를 씀
   - z      : 서비스 수준 계수(1.28=90%, 1.65=95%, 2.33=99%)
   - WAPE   : Σ|실적-예측| / Σ실적. 0인 날이 많은 자재 소비에는 MAPE 대신 이 지표가 맞음
              (MAPE는 실적 0인 날에 정의가 안 됨). 정확도 = 1 - WAPE.

   한계(알고 쓸 것)
   - 스냅샷이 띄엄띄엄이면 그 사이 소비를 균등 분배하므로 변동성이 실제보다 작게 잡힘.
     매 영업일 재고 파일을 올릴수록 σ·정확도가 믿을 만해짐(points·coverage로 표시).
   - 입고 기록 없이 재고가 늘어난 구간(미등록 입고·재고 정정)은 소비 0으로 보고 anomalies로 셈. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FcEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DAY = 86400000;
  const toDate = d => new Date(d + 'T00:00:00');
  const iso = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  const addDays = (d, n) => { const x = toDate(d); x.setDate(x.getDate() + n); return iso(x); };
  const diffDays = (a, b) => Math.round((toDate(a) - toDate(b)) / DAY);
  const num = v => (v == null || v === '' || !isFinite(+v)) ? null : +v;
  const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
  const std = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1)); };

  const Z_BY_SERVICE = { 90: 1.28, 95: 1.65, 99: 2.33 };
  const DEFAULTS = { z: 1.65, review: 7, lt: 2, overDays: 90, horizon: 30, minPoints: 3 };

  /* ── 1. 일 소비량 시계열 ──
     snapshots: [{d:'YYYY-MM-DD', stock:{품목:kg}}] (순서 무관, 같은 날 중복은 뒤 것 우선)
     inbounds : [{d:'YYYY-MM-DD', kg}] — 이 품목의 입고 완료 건(입고일·환산 kg)
     결과 days: 두 스냅샷 사이 소비량(재고 감소 + 그 사이 입고)을 날짜별로 균등 분배한 [{d, v}] */
  function consumptionSeries(snapshots, inbounds, item) {
    const byDay = {};
    (Array.isArray(snapshots) ? snapshots : []).forEach(h => {
      if (!h || typeof h.d !== 'string' || !h.stock) return;
      const v = num(h.stock[item]); if (v == null) return;
      byDay[h.d] = v;
    });
    const pts = Object.keys(byDay).sort().map(d => ({ d, v: byDay[d] }));
    const inb = (Array.isArray(inbounds) ? inbounds : []).filter(o => o && typeof o.d === 'string' && num(o.kg) != null && +o.kg > 0);
    // 구간별 소비 = 재고 감소 + 그 구간(a.d, b.d]에 입고일이 찍힌 입고 kg
    const segs = [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const n = diffDays(b.d, a.d); if (n <= 0) continue;
      const inSeg = inb.filter(o => o.d > a.d && o.d <= b.d).reduce((s, o) => s + +o.kg, 0);
      segs.push({ a, b, n, inb: inSeg, cons: (a.v - b.v) + inSeg });
    }
    /* 소비가 음수인 구간 = 입고 기록 없이 재고가 늘어난 구간. 흔한 원인은 입고일과 재고 파일의
       시점 차이(입고를 전산에 올리기 전에 재고 파일을 뽑았거나 그 반대)라, 바로 앞·뒤 구간에
       기록된 입고가 있으면 그만큼을 그쪽 구간의 소비에서 되돌려 받음(그 구간에 입고분이 소비로
       과대 계상돼 있었으므로). 그래도 남는 증가분은 미등록 입고·재고 정정으로 보고 anomalies로 셈. */
    let anomalies = 0;
    segs.forEach((sg, i) => {
      if (sg.cons >= 0) return;
      let deficit = -sg.cons; sg.cons = 0;
      for (const j of [i - 1, i + 1]) {
        if (deficit <= 0 || !segs[j] || segs[j].inb <= 0) continue;
        const carry = Math.min(deficit, segs[j].inb, Math.max(0, segs[j].cons));
        segs[j].cons -= carry; segs[j].inb -= carry; deficit -= carry;
      }
      if (deficit > 1e-9) anomalies++;
    });
    const days = []; const inKg = inb.filter(o => pts.length && o.d > pts[0].d && o.d <= pts[pts.length - 1].d).reduce((s, o) => s + +o.kg, 0);   // 기간 내 기록된 입고 총량(표시용)
    segs.forEach(sg => {
      const per = sg.cons / sg.n;
      for (let k = 1; k <= sg.n; k++) days.push({ d: addDays(sg.a.d, k), v: per });
    });
    const span = pts.length ? diffDays(pts[pts.length - 1].d, pts[0].d) + 1 : 0;
    return {
      days, points: pts.length, anomalies, inKg,
      from: pts.length ? pts[0].d : null, to: pts.length ? pts[pts.length - 1].d : null,
      coverage: span ? pts.length / span : 0,   // 1에 가까울수록 매일 올린 것
      lastStock: pts.length ? pts[pts.length - 1].v : null
    };
  }

  /* ── 2. 모델 ── 각 모델은 fit(y) → {fitted[], level, trend, phi, name}
     fitted[t]는 t 시점을 "그 전까지의 정보로" 한 발 앞 예측한 값(잔차 계산용) */
  function fitMA(y, w) {
    const fitted = y.map((_, t) => t === 0 ? y[0] : mean(y.slice(Math.max(0, t - w), t)));
    return { name: `이동평균(${w}일)`, kind: 'ma', w, fitted, level: mean(y.slice(-w)), trend: 0, phi: 0 };
  }
  function fitSES(y, alpha) {
    let l = y[0]; const fitted = [y[0]];
    for (let t = 1; t < y.length; t++) { fitted.push(l); l = alpha * y[t] + (1 - alpha) * l; }
    return { name: `지수평활(α${alpha})`, kind: 'ses', alpha, fitted, level: l, trend: 0, phi: 0 };
  }
  function fitHolt(y, alpha, beta, phi) {
    let l = y[0], b = y.length > 1 ? y[1] - y[0] : 0; const fitted = [y[0]];
    for (let t = 1; t < y.length; t++) {
      fitted.push(l + phi * b);
      const ln = alpha * y[t] + (1 - alpha) * (l + phi * b);
      b = beta * (ln - l) + (1 - beta) * phi * b; l = ln;
    }
    return { name: `추세(α${alpha}·β${beta})`, kind: 'holt', alpha, beta, fitted, level: l, trend: b, phi };
  }
  /* 모델의 k일 뒤 예측(1부터 h까지). 감쇠 추세(φ)로 추세가 무한히 커지는 것을 막고 음수는 0 */
  function path(model, h) {
    const out = [];
    for (let k = 1; k <= h; k++) {
      let v = model.level;
      if (model.kind === 'holt') v += model.trend * (model.phi === 1 ? k : model.phi * (1 - Math.pow(model.phi, k)) / (1 - model.phi));
      out.push(Math.max(0, v));
    }
    return out;
  }
  /* 앞으로 days일 평균 소비율 — 리드타임·검토주기 구간에 쓰는 대표값 */
  function rateFor(model, days) {
    const h = Math.max(1, Math.ceil(days));
    return mean(path(model, h));
  }
  const CANDIDATES = [
    y => fitMA(y, 7), y => fitMA(y, 14), y => fitMA(y, 28),
    y => fitSES(y, 0.1), y => fitSES(y, 0.2), y => fitSES(y, 0.3), y => fitSES(y, 0.5),
    y => fitHolt(y, 0.2, 0.05, 0.9), y => fitHolt(y, 0.4, 0.1, 0.9)
  ];
  const mae = (a, f) => mean(a.map((v, i) => Math.abs(v - f[i])));
  const wape = (a, f) => { const den = a.reduce((s, v) => s + Math.abs(v), 0); return den > 0 ? a.reduce((s, v, i) => s + Math.abs(v - f[i]), 0) / den : null; };

  /* 모델 선택·적합. y: 하루 소비량 숫자 배열(시간순)
     - 표본 14일 이상: 마지막 20%(최소 7일)를 떼어 "그 구간 전체를 미리 예측"한 MAE로 고름(실제 쓰임새와 같은 평가)
     - 그보다 적으면 한 발 앞 예측 MAE로 고름
     반환: {model, rate(h일 평균), sigma, accuracy(검증 1-WAPE, 없으면 null), n, validated(검증 기간 일수)} */
  function fit(series, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const y = (Array.isArray(series) ? series : []).map(v => (typeof v === 'object' && v) ? v.v : v).map(num).filter(v => v != null && v >= 0);
    const n = y.length;
    if (n < o.minPoints) return null;
    const hold = n >= 14 ? Math.max(7, Math.floor(n * 0.2)) : 0;
    const train = hold ? y.slice(0, n - hold) : y, test = hold ? y.slice(n - hold) : null;
    let best = null;
    CANDIDATES.forEach(make => {
      const m = make(train);
      const err = test ? mae(test, path(m, hold)) : mae(train.slice(1), m.fitted.slice(1));
      if (best == null || err < best.err - 1e-9) best = { make, err, m };
    });
    const model = best.make(y);   // 고른 모델을 전체 표본으로 다시 적합
    const resid = y.slice(1).map((v, i) => v - model.fitted[i + 1]);
    const sigma = std(resid);
    const w = test ? wape(test, path(best.m, hold)) : null;
    return {
      model: model.name, kind: model.kind, level: model.level, trend: model.trend, phi: model.phi,
      rate: rateFor(model, o.horizon), rateFor: d => rateFor(model, d),
      sigma, n, validated: hold, accuracy: w == null ? null : Math.max(0, 1 - w)
    };
  }

  /* ── 3. 재고 판단 ── */
  // 안전재고 = z × σ × √(리드타임 + 검토주기). 하루 미만 리드타임도 최소 1일로 봄(당일 입고라도 하루치 변동은 남음)
  function safetyStock(sigma, lt, review, z) {
    const s = Math.max(0, num(sigma) || 0);
    const horizon = Math.max(1, (num(lt) || 0) + (num(review) || 0));
    return (z == null ? DEFAULTS.z : z) * s * Math.sqrt(horizon);
  }
  // 동적 발주점 = 리드타임 중 소비 + 안전재고
  function dynamicRop(rate, lt, ss) { return Math.max(0, (num(rate) || 0) * Math.max(0, num(lt) || 0) + (num(ss) || 0)); }
  /* 소진 예상일수와 범위. 누적 소비 n일 분산이 n·σ²인 것을 써서
     낙관(lo): rate·n + z·σ·√n = stock, 비관(hi): rate·n − z·σ·√n = stock 을 √n에 대해 풀음 */
  function depletion(stock, rate, sigma, z) {
    const s = num(stock), r = num(rate);
    if (s == null || r == null || r <= 0) return null;
    if (s <= 0) return { days: 0, lo: 0, hi: 0 };
    const zz = z == null ? DEFAULTS.z : z, sg = Math.max(0, num(sigma) || 0);
    const disc = Math.sqrt(zz * zz * sg * sg + 4 * r * s);
    const lo = Math.pow((-zz * sg + disc) / (2 * r), 2);
    const hi = Math.pow((zz * sg + disc) / (2 * r), 2);
    return { days: s / r, lo, hi };
  }
  /* 리스크 등급 — 입고 예정분까지 합친 가용량(stock+onOrder)으로 부족·발주 필요를 가르고,
     과잉은 현재고만으로 봄(발주를 또 하면 더 쌓이므로)
     none  : 소비 추세 없음(판단 불가)
     short : 가용량이 리드타임 소비분 이하 — 지금 발주해도 도착 전에 소진
     order : 가용량이 목표 수준(리드타임+검토주기 소비 + 안전재고) 이하 — 다음 검토 전에 발주점 아래로 내려감.
             suggestQty가 0보다 큰 조건과 정확히 같아서 "정상인데 권장 발주량이 있는" 모순이 안 생김
     excess: 현재고가 overDays일분 이상 / ok: 그 외 */
  function risk(p) {
    const r = num(p.rate); if (r == null || r <= 0) return 'none';
    const stock = Math.max(0, num(p.stock) || 0), onOrder = Math.max(0, num(p.onOrder) || 0), ss = Math.max(0, num(p.ss) || 0);
    const lt = Math.max(0, num(p.lt) || 0), review = Math.max(0, num(p.review) || 0), over = num(p.overDays) == null ? DEFAULTS.overDays : p.overDays;
    const avail = stock + onOrder;
    if (avail <= r * lt) return 'short';
    if (avail <= r * (lt + review) + ss) return 'order';
    if (stock / r >= over) return 'excess';
    return 'ok';
  }
  /* 권장 발주량 = (리드타임+검토주기 소비 + 안전재고) − 현재고 − 입고예정. 최소 발주량·로트 단위 반영 */
  function suggestQty(p) {
    const r = Math.max(0, num(p.rate) || 0);
    if (r <= 0) return 0;
    const target = r * (Math.max(0, num(p.lt) || 0) + Math.max(0, num(p.review) || 0)) + Math.max(0, num(p.ss) || 0);
    let need = target - Math.max(0, num(p.stock) || 0) - Math.max(0, num(p.onOrder) || 0);
    if (need <= 0) return 0;
    const minQty = Math.max(0, num(p.minQty) || 0), lot = Math.max(0, num(p.lot) || 0);
    let q = Math.max(need, minQty);
    if (lot > 0) q = Math.ceil(q / lot - 1e-9) * lot;
    return Math.round(q);
  }

  /* ── 4. 한 품목 종합 판단 ──
     p: {series(일 소비 배열), stock, onOrder, lt, review, z, overDays, minQty, lot, rop(등록 발주점·표시용)} */
  function assess(p) {
    const o = Object.assign({}, DEFAULTS, p || {});
    const f = fit(o.series, { horizon: o.horizon, minPoints: o.minPoints });
    const stock = num(o.stock);
    if (!f) return { ok: false, reason: '표본 부족', n: (o.series || []).length, stock };
    const rate = f.rateFor(Math.max(1, o.lt + o.review));
    const ss = safetyStock(f.sigma, o.lt, o.review, o.z);
    const dynRop = dynamicRop(rate, o.lt, ss);
    const onOrder = Math.max(0, num(o.onOrder) || 0);
    const depl = stock == null ? null : depletion(stock, rate, f.sigma, o.z);
    const rk = stock == null ? 'none' : risk({ rate, stock, onOrder, ss, lt: o.lt, review: o.review, overDays: o.overDays });
    const qty = stock == null ? 0 : suggestQty({ rate, lt: o.lt, review: o.review, ss, stock, onOrder, minQty: o.minQty, lot: o.lot });
    return {
      ok: true, model: f.model, n: f.n, validated: f.validated, accuracy: f.accuracy,
      rate, sigma: f.sigma, ss, dynRop, stock, onOrder,
      cover: depl ? depl.days : null, coverIncl: (depl && rate > 0) ? (stock + onOrder) / rate : null,
      depletion: depl, risk: rk, suggestQty: qty
    };
  }

  const RISK_LABEL = { short: '부족 위험', order: '발주 필요', excess: '과잉', ok: '정상', none: '판단 불가' };
  const RISK_ORDER = { short: 0, order: 1, excess: 2, ok: 3, none: 4 };

  return { consumptionSeries, fit, path, rateFor, safetyStock, dynamicRop, depletion, risk, suggestQty, assess, RISK_LABEL, RISK_ORDER, Z_BY_SERVICE, DEFAULTS, _addDays: addDays, _diffDays: diffDays };
});
