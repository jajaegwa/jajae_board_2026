/* 화면 표시용 순수 함수 모음 — DOM·네트워크·S(업무 데이터) 변경 없음.
   index.html·magam.html이 window.UiHelpers로 쓰고, ui-helpers.test.cjs가 node:test로 검증함.
   여기 있는 함수는 "무엇을 어떻게 보여줄지"만 정함 — 집계 기준 자체(어떤 건을 셀지)는
   기존 화면 로직과 똑같이 맞춰 두었으므로, 업무 규칙을 바꾸려면 이 파일이 아니라 담당자 확인이 먼저임. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UiHelpers = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* 창고→라인 이동 요청 건수 구분.
     - total        : 그 날짜에 등록된 전체 요청(완료 포함) — 캘린더 "이동 N"이 세는 값
     - physPending  : 실물 이동 대기(!done) — 현황 요약 "창고이동 남은 건"이 세던 값
     - erpPending   : 실물 이동은 끝났는데 전산 이동이 안 된 건(done && !erp) — 기존 "전산 N건 남음"이 세던 값
     - erpOpen      : 전산 이동 미처리 전체(!erp, 실물 여부 무관) — 참고용
     - complete     : 실물·전산 모두 끝난 건 */
  function moveCounts(moves) {
    const list = Array.isArray(moves) ? moves : [];
    let physPending = 0, erpPending = 0, erpOpen = 0, complete = 0;
    for (const m of list) {
      if (!m || typeof m !== 'object') continue;
      if (!m.done) physPending++;
      if (m.done && !m.erp) erpPending++;
      if (!m.erp) erpOpen++;
      if (m.done && m.erp) complete++;
    }
    return { total: list.filter(m => m && typeof m === 'object').length, physPending, erpPending, erpOpen, complete };
  }
  function moveCountText(c) {
    if (!c || !c.total) return '';
    return `전체 ${c.total} · 실물 대기 ${c.physPending} · 전산 대기 ${c.erpPending}`;
  }

  /* 발주 주기 표기 — 저장 데이터에는 '주2회'·'주 2회'가 섞여 있음(masterData·서버 기준정보).
     저장값은 건드리지 않고 화면에서만 띄어쓰기 표기로 통일. */
  const CYCLE_CANON = ['매일', '주 2회', '주 1회', '격주', '3주 1회', '월 1회'];
  function cycleLabel(c) {
    const s = String(c ?? '').trim();
    if (!s) return '';
    const k = s.replace(/\s+/g, '');
    const hit = CYCLE_CANON.find(x => x.replace(/\s+/g, '') === k);
    return hit || s;
  }
  /* 셀렉트 선택지: 표준 표기만, 현재값이 표준에 없으면(예: 사용자 임의 값) 잃지 않게 끝에 덧붙임 */
  function cycleOptions(current) {
    const cur = cycleLabel(current);
    const opts = CYCLE_CANON.slice();
    if (cur && !opts.includes(cur)) opts.push(cur);
    return opts.map(v => ({ value: v, selected: v === cur }));
  }
  /* 셀렉트에서 고른 표준 표기가 저장값과 표기만 다르면 저장값을 그대로 둠(불필요한 데이터 변경 방지) */
  function cycleValueToStore(selected, stored) {
    return cycleLabel(stored) === selected ? stored : selected;
  }
  /* 프리셋 라벨 안의 '주2회'·'3주1회' 같은 붙여 쓴 표기를 화면 표시용으로만 정리 */
  function cycleText(s) {
    return String(s ?? '').replace(/(3주|주|월)\s*(\d)회/g, '$1 $2회');
  }

  /* 연결·저장 상태 — 사용자가 "이 기기에만 저장"을 실시간 공유로 오해하지 않게 상태를 분명히 나눔 */
  function connState(o) {
    o = o || {};
    if (o.sample) return { mode: 'sample', label: '샘플 데이터', detail: '실제 업무 데이터가 아닙니다 — 실시간 공유에 연결해야 실제 내용이 보입니다', warn: true };
    if (o.readOnly) return { mode: 'ro', label: '읽기 전용', detail: '체크·입력이 저장되지 않습니다', warn: true };
    if (o.pending) return { mode: 'pending', label: '저장 대기 선택 필요', detail: '이 기기에 서버로 못 보낸 변경이 있습니다 — 위 배너에서 선택하세요', warn: true };
    if (o.sbOK) {
      if (o.gaveUp) return { mode: 'error', label: '공유 저장 실패', detail: '자동 재시도를 멈췄습니다 — 새로고침 후 다시 입력하세요', warn: true };
      if (o.saveFailed) return { mode: 'error', label: '공유 저장 재시도 중', detail: '네트워크를 확인하세요 — 다른 사람 화면에 아직 반영되지 않았습니다', warn: true };
      return { mode: 'shared', label: '실시간 공유', detail: '다른 사람 화면에도 반영됩니다', warn: false };
    }
    if (o.cap) return { mode: 'shared', label: '공유 저장', detail: '아티팩트 공유 저장 사용 중', warn: false };
    return { mode: 'local', label: '이 기기에만 저장', detail: o.sbAvailable ? '다른 사람 화면에 반영되지 않습니다 — 실시간 공유에 연결하세요' : '네트워크 차단 환경 — 다른 사람 화면에 반영되지 않습니다', warn: true };
  }

  /* 사급 발주서 인식 결과 → 등록 단계 요약. commitCs()의 필터 조건(item && qty && action!=='제외')과 동일 */
  function consDraftSummary(draft) {
    const list = Array.isArray(draft) ? draft : [];
    const valid = [], excluded = [], errors = [], check = [];
    list.forEach((d, i) => {
      if (!d) return;
      const hasItem = !!String(d.item ?? '').trim();
      if (d.action === '제외' && hasItem) { excluded.push(i); return; }
      if (!hasItem || !(+d.qty > 0)) { errors.push({ row: i, reason: !hasItem ? '품목 없음' : '수량 없음' }); return; }
      valid.push(i);
      if (d.action === '확인') check.push(i);
    });
    return { total: list.length, valid: valid.length, excluded: excluded.length, check: check.length, errors };
  }

  /* 월마감 표 빈 상태 — 업체가 아예 없는 것과 필터 결과가 없는 것을 구분 */
  function emptyReason(totalCount, shownCount, activeFilters) {
    if (shownCount > 0) return 'none';
    if (!totalCount) return 'noData';
    return (activeFilters && activeFilters.length) ? 'filtered' : 'noMatch';
  }

  /* 원료예측 [예측 계산] 버튼 사용 가능 여부 */
  function fcCalcState(hasBom, planCount) {
    if (!hasBom) return { enabled: false, reason: 'BOM 미업로드 — ① BOM 엑셀을 먼저 올려야 예측을 계산할 수 있습니다' };
    if (!(planCount > 0)) return { enabled: false, reason: '생산계획 없음 — ② 생산계획을 올리거나 붙여넣으세요' };
    return { enabled: true, reason: '' };
  }

  /* 되돌리기용 필드 스냅샷 — 없던 필드는 undefined로 기록해 복원 시 지움 */
  function snapshot(obj, fields) {
    const s = {};
    fields.forEach(f => { s[f] = Object.prototype.hasOwnProperty.call(obj, f) ? obj[f] : undefined; });
    return s;
  }
  function restore(obj, snap) {
    Object.keys(snap).forEach(f => { if (snap[f] === undefined) delete obj[f]; else obj[f] = snap[f]; });
    return obj;
  }

  /* 캘린더 날짜 칸의 스크린리더용 설명 */
  function calDayLabel(dateLabel, ins, mvs, outs, selected) {
    const parts = [];
    if (ins) parts.push(`입고 ${ins}건`);
    if (mvs) parts.push(`창고→라인 이동 ${mvs}건(완료 포함)`);
    if (outs) parts.push(`출고 ${outs}건`);
    return `${dateLabel}${parts.length ? ' · ' + parts.join(', ') : ' · 일정 없음'}${selected ? ' · 선택됨' : ''}`;
  }

  /* 마감 메일 문구 — 마감관리 매입 탭 [마감 메일 복사] 버튼.
     "N일자로 세금계산서 발행"의 N은 그 마감월의 마지막 영업일(토·일·공휴일 제외).
     공휴일은 연도별 표로 관리(대체공휴일·선거일·임시공휴일 포함). 표에 없는 연도는 토·일만 빼고
     계산하되 holidayKnown=false를 돌려줘 화면에서 안내함. 새 해가 오면 아래 표에 한 해를 추가할 것.
     출처: 정부 월력요항·언론 보도(2026: 대체공휴일 3/2·5/25·8/17·10/5, 6/3 지방선거, 노동절·제헌절은
     2026-04부터 공휴일 / 2027: 대체공휴일 2/9·5/3·7/19·8/16·10/4·10/11·12/27, 추석 9/14~16). */
  const KR_HOLIDAYS = {
    2025: ['01-01', '01-27', '01-28', '01-29', '01-30', '03-01', '03-03', '05-05', '05-06', '06-03', '06-06',
      '08-15', '10-03', '10-05', '10-06', '10-07', '10-08', '10-09', '12-25'],
    2026: ['01-01', '02-16', '02-17', '02-18', '03-01', '03-02', '05-01', '05-05', '05-24', '05-25', '06-03',
      '06-06', '07-17', '08-15', '08-17', '09-24', '09-25', '09-26', '10-03', '10-05', '10-09', '12-25'],
    2027: ['01-01', '02-06', '02-07', '02-08', '02-09', '03-01', '05-01', '05-03', '05-05', '05-13', '06-06',
      '07-17', '07-19', '08-15', '08-16', '09-14', '09-15', '09-16', '10-03', '10-04', '10-09', '10-11',
      '12-25', '12-27']
  };
  const YM_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
  const pad2 = n => String(n).padStart(2, '0');
  /* ym: 'YYYY-MM' → { date:'YYYY-MM-DD', day:숫자, holidayKnown } — 그 달의 마지막 영업일.
     Date는 로컬(UTC 시차 무관)로만 다룸. 잘못된 ym이면 null. */
  function lastBizDay(ym, holidays) {
    const m = YM_RE.exec(String(ym || ''));
    if (!m) return null;
    const y = +m[1], mo = +m[2];
    const table = holidays || KR_HOLIDAYS;
    const hol = new Set((table[y] || []).map(md => `${y}-${md}`));
    // 다음 달 0일 = 이 달 마지막 날부터 하루씩 거슬러 올라가며 첫 영업일을 찾음
    for (const d = new Date(y, mo, 0); d.getMonth() === mo - 1; d.setDate(d.getDate() - 1)) {
      const wd = d.getDay();
      const iso = `${y}-${m[2]}-${pad2(d.getDate())}`;
      if (wd === 0 || wd === 6 || hol.has(iso)) continue;
      return { date: iso, day: d.getDate(), holidayKnown: !!table[y] };
    }
    return null;
  }
  /* 문구는 담당자가 보내준 메일 원문 그대로. 월·일만 치환. */
  function closingMailText(ym, holidays) {
    const b = lastBizDay(ym, holidays);
    if (!b) return null;
    const mm = b.date.slice(5, 7); // 원문 표기("09월")를 따라 두 자리 유지
    return { text: `안녕하세요 현대엘앤씨 물류팀 선임 김성진입니다.

${mm}월 마감 내역 수량, 금액 확인하였습니다.

${b.day}일자로 세금계산서 발행부탁드립니다.

감사합니다.

김성진 드림.`, month: mm, day: b.day, date: b.date, holidayKnown: b.holidayKnown };
  }

  return { moveCounts, moveCountText, CYCLE_CANON, cycleLabel, cycleOptions, cycleValueToStore, cycleText, connState,
    consDraftSummary, emptyReason, fcCalcState, snapshot, restore, calDayLabel, KR_HOLIDAYS, lastBizDay, closingMailText };
});
