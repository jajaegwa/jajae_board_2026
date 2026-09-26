const {test}=require('node:test');
const assert=require('node:assert/strict');
const U=require('./ui-helpers.js');

test('창고→라인 이동 건수: 전체·실물 대기·전산 대기를 구분하고 기존 집계와 같은 기준',()=>{
  const mv=[{done:false},{done:true},{done:true,erp:'2026-09-26 10:00'},{done:false,erp:'2026-09-26 09:00'}];
  const c=U.moveCounts(mv);
  assert.equal(c.total,4);             // 캘린더 "이동 N" = 완료 포함 전체
  assert.equal(c.physPending,2);       // 기존 현황 "창고이동 남은 건" = !done
  assert.equal(c.erpPending,1);        // 기존 "전산 N건 남음" = done && !erp
  assert.equal(c.erpOpen,2);
  assert.equal(c.complete,1);
  assert.equal(U.moveCountText(c),'전체 4 · 실물 대기 2 · 전산 대기 1');
});
test('이동 건수: 빈 목록·이상 데이터에 안전',()=>{
  assert.deepEqual(U.moveCounts(null),{total:0,physPending:0,erpPending:0,erpOpen:0,complete:0});
  assert.equal(U.moveCounts([null,'x',{done:false}]).total,1);
  assert.equal(U.moveCountText(U.moveCounts([])),'');
});
test('주기 표기: 붙여쓴 표기를 화면에서만 통일하고 저장값은 표기 차이로 바꾸지 않음',()=>{
  assert.equal(U.cycleLabel('주2회'),'주 2회');
  assert.equal(U.cycleLabel('3주1회'),'3주 1회');
  assert.equal(U.cycleLabel('격주'),'격주');
  assert.equal(U.cycleLabel('2개월'),'2개월');
  const opts=U.cycleOptions('주2회');
  assert.equal(opts.filter(o=>o.value.replace(/\s/g,'')==='주2회').length,1,'중복 선택지 없음');
  assert.equal(opts.find(o=>o.selected).value,'주 2회');
  assert.equal(U.cycleValueToStore('주 2회','주2회'),'주2회','표기만 다르면 기존 저장값 유지');
  assert.equal(U.cycleValueToStore('격주','주2회'),'격주');
  assert.ok(U.cycleOptions('2개월').some(o=>o.value==='2개월'&&o.selected),'표준 외 값도 잃지 않음');
  assert.equal(U.cycleText('CR-102NT | 주2회 | 100kg'),'CR-102NT | 주 2회 | 100kg');
});
test('연결 상태: 샘플·이 기기 저장·실시간 공유를 구분',()=>{
  assert.equal(U.connState({sample:true,sbOK:true}).mode,'sample');
  assert.equal(U.connState({}).mode,'local');
  assert.ok(U.connState({}).warn);
  assert.equal(U.connState({sbOK:true}).mode,'shared');
  assert.equal(U.connState({sbOK:true}).warn,false);
  assert.equal(U.connState({sbOK:true,saveFailed:true}).mode,'error');
  assert.equal(U.connState({readOnly:true,sbOK:true}).mode,'ro');
  assert.equal(U.connState({pending:true,sbOK:true}).mode,'pending');
  assert.equal(U.connState({cap:true}).mode,'shared');
});
test('사급 인식 결과 요약: commitCs와 같은 기준으로 등록/제외/오류 행을 셈',()=>{
  const s=U.consDraftSummary([
    {item:'IF-850',qty:1500,action:'발주'},
    {item:'M-210',qty:200,action:'확인'},
    {item:'X',qty:10,action:'제외'},
    {item:'',qty:10,action:'발주'},
    {item:'Y',qty:null,action:'직접출고'},
  ]);
  assert.equal(s.total,5);assert.equal(s.valid,2);assert.equal(s.excluded,1);assert.equal(s.check,1);
  assert.deepEqual(s.errors.map(e=>e.reason),['품목 없음','수량 없음']);
});
test('월마감 빈 상태: 업체 0개와 필터 결과 0개를 구분',()=>{
  assert.equal(U.emptyReason(0,0,[]),'noData');
  assert.equal(U.emptyReason(0,0,['미완만']),'noData','업체가 없으면 필터 탓이 아님');
  assert.equal(U.emptyReason(5,0,['검색 "A"']),'filtered');
  assert.equal(U.emptyReason(5,0,[]),'noMatch');
  assert.equal(U.emptyReason(5,3,[]),'none');
});
test('원료예측 계산 버튼: BOM·계획이 없으면 비활성과 이유',()=>{
  assert.equal(U.fcCalcState(false,3).enabled,false);
  assert.match(U.fcCalcState(false,3).reason,/BOM/);
  assert.equal(U.fcCalcState(true,0).enabled,false);
  assert.equal(U.fcCalcState(true,2).enabled,true);
});
test('되돌리기 스냅샷: 없던 필드는 복원 시 지움',()=>{
  const o={id:1,done:false};
  const snap=U.snapshot(o,['done','doneBy','doneAt']);
  o.done=true;o.doneBy='기사';o.doneAt='x';
  U.restore(o,snap);
  assert.deepEqual(o,{id:1,done:false});
});
test('캘린더 날짜 설명',()=>{
  assert.equal(U.calDayLabel('9월 26일(토)',1,2,0,true),'9월 26일(토) · 입고 1건, 창고→라인 이동 2건(완료 포함) · 선택됨');
  assert.equal(U.calDayLabel('9월 1일(화)',0,0,0,false),'9월 1일(화) · 일정 없음');
});
