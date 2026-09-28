const {test}=require('node:test');
const assert=require('node:assert/strict');
const E=require('./sales-match-engine.js');
const aliases=require('./alias-candidates.json');
const s=(x={})=>({sourceSystem:'TEST',issuerId:'TEST',documentNo:'1',documentLine:'1',vendor:'동부엔지니어링',item:'IF850',qty:1000,unit:'kg',date:'2026-09-07',...x});
const o=(x={})=>({id:'1',action:'발주',vendor:'동부엔지니어링',item:'IF-850',qty:1000,unit:'kg',orderDate:'2026-09-01',requestDate:'2026-08-31',done:false,...x});
function commit(sale,orders,ledger=[],extra={}) {
 const p=E.preview(sale,orders,ledger,aliases,{packKgOf:extra.packKgOf,manualOrderIds:extra.manualOrderIds,separateSale:extra.separateSale,batchKeys:extra.batchKeys});
 return E.commit({sale,orders,ledger,aliases,allocations:p.proposal,actor:'테스트',now:'2026-09-08T00:00:00Z',eventId:'e1',
 expectedOrders:Object.fromEntries(p.candidates.map(c=>[String(c.orderId),c.orderSnapshot])),expectedSourceSnapshot:p.sourceSnapshot,...extra});
}
test('법인 표기를 문자열로 제거하고 회사 이름 글자는 보존',()=>{
 assert.equal(E.vendorName('주식회사신호인더스트리(3118114892)'),E.vendorName('신호인더스트리'));
 assert.equal(E.vendorName('주성회사'),'주성회사');
});
test('IF850 하이픈 차이',()=>assert.equal(E.preview(s(),[o()]).status,'READY'));
test('다른 사업자번호 차단',()=>assert.equal(E.preview(s({vendorRegNo:'1111111111'}),[o({vendorRegNo:'2222222222'})]).status,'NO_CANDIDATE'));
test('293F-1과 293F-10 양방향 차단',()=>{
 for(const [a,b] of [['293F-1','293F-10'],['293F-10','293F-1']])
 assert.equal(E.preview(s({item:'장식_'+a+'_Drum(170kg)'}),[o({item:b})]).status,'NO_CANDIDATE');
});
test('LOX PF와 PL 차단',()=>assert.equal(E.preview(s({item:'LOX-203PF'}),[o({item:'LOX-203PL'})]).status,'NO_CANDIDATE'));
test('공통 TiO2 분류와 포장중량으로 다른 품목 연결 금지',()=>{
 assert.equal(E.preview(s({item:'장식_TiO2_KA-100_P/B(25kg)'}),[o({item:'장식_TiO2_K2450_P/B(25kg)'})]).status,'NO_CANDIDATE');
});
test('공통 ERP 품목코드 충돌은 이름이 같아도 차단',()=>assert.equal(E.preview(s({itemCode:'A1'}),[o({itemCode:'B1'})]).status,'NO_CANDIDATE'));
test('직접출고 완료 건은 정상 후보(READY)이며 미리보기가 원본을 변경하지 않음',()=>{
 const orders=[o({action:'직접출고',done:true,outDate:'2026-09-02',item:'P-560J 14동 1열',qty:200})];
 const original=JSON.stringify(orders);
 const p=E.preview(s({item:'경질_가공조제_P-560J_P/B(25kg)',qty:200}),orders);
 assert.equal(p.candidates.length,1);assert.equal(p.status,'READY');assert.equal(p.candidates[0].done,true);
 assert.equal(JSON.stringify(orders),original);
});
test('KSC AT와 L8710은 최초 승인 후보',()=>{
 const p=E.preview(s({vendor:'주식회사 케이에스씨에이티(1318664447)',item:'장식_안료_HELIOGEN GREEN L 8710_P/B(10kg)',qty:600}),
 [o({vendor:'KSC AT',item:'P.GREEN(L8710)',qty:600})],[],aliases);
 assert.equal(p.candidates.length,1);assert.equal(p.status,'REVIEW');
});
test('PMMA850BD는 수량 같아도 미승인 별칭',()=>{
 const p=E.preview(s({vendor:'케이에스씨에이티',item:'IF850B-G1L',qty:9700}),[o({vendor:'KSC AT',item:'PMMA(850BD)',qty:9700})],[],aliases);
 assert.equal(p.status,'REVIEW');assert.equal(p.candidates.length,1);
});
test('공급사가 같아도 다른 사급처에 연결 금지',()=>assert.equal(E.preview(s({vendor:'두성플러스',qty:8000}),[o({vendor:'한엘',qty:8000})]).status,'NO_CANDIDATE'));
test('두성플러스와 두성코리아 통합 금지',()=>assert.equal(E.preview(s({vendor:'두성플러스'}),[o({vendor:'두성코리아'})],[],aliases).status,'NO_CANDIDATE'));
test('과거 매각을 새 발주에 배분 금지',()=>assert.equal(E.preview(s({date:'2026-08-01'}),[o()]).status,'NO_CANDIDATE'));
test('10000+1000 유일 합계 11000',()=>{
 const p=E.preview(s({qty:11000}),[o({qty:10000}),o({id:'2',qty:1000})]);
 assert.equal(p.status,'READY');assert.equal(p.proposal.length,2);
});
test('1000 세 건 중 2000 선택은 오래된 발주부터 선입선출(같은 날짜면 번호 순)',()=>{
 const p=E.preview(s({qty:2000}),[o(),o({id:'2'}),o({id:'3'})]);
 assert.equal(p.status,'READY');assert.equal(p.subsetKind,'fifo');
 assert.deepEqual(p.proposal.map(a=>String(a.orderId)),['1','2']);
 assert.ok(p.candidates.find(c=>c.orderId==='1').reasons.some(r=>/선입선출/.test(r)));
 assert.ok(!p.candidates.find(c=>c.orderId==='3').reasons.some(r=>/선입선출/.test(r)));
 // 발주일이 다르면 번호가 아니라 날짜 순 — 9/3(1)·9/1(2)·9/2(3) → 2·3
 const q=E.preview(s({qty:2000,date:'2026-09-07'}),[o({orderDate:'2026-09-03'}),o({id:'2',orderDate:'2026-09-01'}),o({id:'3',orderDate:'2026-09-02'})]);
 assert.deepEqual(q.proposal.map(a=>String(a.orderId)).sort(),['2','3']);
 // 구성이 다른 조합끼리도 가장 오래된 발주를 포함하는 쪽 — 9/1 1000 + 9/5 2000 vs 9/3 3000 → 앞쪽
 const r=E.preview(s({qty:3000,date:'2026-09-07'}),[o({orderDate:'2026-09-03',qty:3000}),o({id:'2',orderDate:'2026-09-01',qty:1000}),o({id:'3',orderDate:'2026-09-05',qty:2000})]);
 assert.deepEqual(r.proposal.map(a=>String(a.orderId)).sort(),['2','3']);
 // 반영하면 그 두 건이 소진되고, 다음 같은 매각은 남은 한 건으로 유일 조합
 const led=commit(s({qty:2000}),[o(),o({id:'2'}),o({id:'3'})]);
 const n=E.preview(s({qty:1000,documentNo:'2'}),[o(),o({id:'2'}),o({id:'3'})],led);
 assert.equal(n.status,'READY');assert.deepEqual(n.proposal.map(a=>String(a.orderId)),['3']);
 // 조합 탐색 상한을 넘으면 종전대로 REVIEW
 const many=Array.from({length:E.SUBSET_CAP+1},(_,i)=>o({id:String(i+1)}));
 assert.equal(E.preview(s({qty:2000}),many).status,'REVIEW');
});
test('P3000 3079/3000 차이 79 노출',()=>{
 const p=E.preview(s({item:'P3000',qty:3079}),[o({item:'P-3000',qty:3000})]);
 assert.equal(p.status,'QUANTITY_REVIEW');assert.equal(p.candidates[0].quantityDifference,79);
});
test('톤/kg 환산, 길이/중량 혼합 차단',()=>{
 assert.equal(E.preview(s({qty:1,unit:'ton'}),[o()]).status,'READY');
 assert.equal(E.preview(s({unit:'m'}),[o()]).status,'NO_CANDIDATE');
});
test('미상 단위는 미리보기 가능하지만 확정 불가',()=>{
 const sale=s({unit:''});assert.equal(E.preview(sale,[o()]).status,'REVIEW');
 assert.throws(()=>commit(sale,[o()],[],{reviewConfirmed:true,reviewReason:'확인'}),/단위/);
});
test('음수 반품과 잘못된 날짜 차단',()=>{
 assert.equal(E.preview(s({qty:-100}),[o()]).status,'INVALID');
 assert.equal(E.isoDate('2026-02-30'),'');
 assert.throws(()=>commit(s({date:'2026-02-30'}),[o()],[],{reviewConfirmed:true,reviewReason:'검토'}),/날짜/);
});
test('정확한 전표행 재업로드는 기존 반영으로 분류',()=>{
 const sale=s(),orders=[o()],ledger=commit(sale,orders);
 assert.equal(E.preview(sale,[...orders,o({id:'2'})],ledger).status,'ALREADY_LINKED');
 assert.equal(orders[0].done,false);
});
test('동일 전표행 수량 변경은 정정 필요',()=>{
 const ledger=commit(s(),[o()]);assert.equal(E.preview(s({qty:2000}),[o()],ledger).status,'SOURCE_CHANGED');
});
test('전표행도 순번도 없는 자료는 식별자 없음 → 자동 확정 불가',()=>{
 const sale=s({documentNo:''});assert.equal(E.preview(sale,[o()]).status,'REVIEW');
 assert.throws(()=>commit(sale,[o()],[],{reviewConfirmed:true,reviewReason:'검토'}),/식별자/);
});
test('부분 배분 누적 및 원천/대상 잔량 초과 차단',()=>{
 const sale=s(),orders=[o({qty:2000})];
 const l=commit(sale,orders,[],{allocations:[{orderId:'1',baseQty:1000}],reviewConfirmed:true,reviewReason:'부분 매각'});
 assert.equal(E.remainingOrder(orders[0],l),1000);
 const l2=commit(s({documentNo:'2'}),orders,l,{eventId:'e2'});
 assert.equal(E.remainingOrder(orders[0],l2),0);
 assert.throws(()=>commit(s(),[o()],[],{allocations:[{orderId:'1',baseQty:1001}]}),/초과/);
});
test('확정 직전 원본 변경 검출',()=>{
 assert.throws(()=>commit(s(),[o()],[],{expectedOrders:{'1':'old'}}),/스냅샷/);
 assert.throws(()=>commit(s(),[o()],[],{expectedSourceSnapshot:'old'}),/스냅샷/);
});
test('입고 완료된 발주는 매각의 정상 대응 — 검토 없이 연결되고 기존 완료일은 보존',()=>{
 const orders=[o({done:true,inDate:'2026-09-02'})];
 assert.equal(E.preview(s(),orders).status,'READY');
 const ledger=commit(s(),orders);
 assert.equal(ledger.length,1);assert.equal(orders[0].inDate,'2026-09-02');
 assert.equal(E.remainingOrder(orders[0],ledger),0);
});
test('직접 지정: 업체·품목이 안 맞는 발주도 후보가 되지만 검토 사유는 필수',()=>{
 const other=o({id:'9',vendor:'전혀다른업체',item:'ZZZ-1'});
 assert.equal(E.preview(s(),[other]).status,'NO_CANDIDATE');
 const p=E.preview(s(),[other],[],aliases,{manualOrderIds:['9']});
 assert.equal(p.status,'REVIEW');assert.equal(p.candidates.length,1);
 assert.ok(p.candidates[0].issues.includes('담당자 직접 지정'));
 const alloc=[{orderId:'9',baseQty:1000}];
 assert.throws(()=>commit(s(),[other],[],{manualOrderIds:['9'],allocations:alloc}),/검토/);
 const ledger=commit(s(),[other],[],{manualOrderIds:['9'],allocations:alloc,reviewConfirmed:true,reviewReason:'담당자 직접 지정'});
 assert.equal(ledger[0].allocations[0].orderId,'9');
 assert.throws(()=>commit(s(),[other],[],{allocations:alloc,reviewConfirmed:true,reviewReason:'x'}),/NO_CANDIDATE/);
});
test('직접 지정도 사업자번호 충돌·잔량 없음·단위 종류 불일치는 넘지 못하고 사유가 남음',()=>{
 const p1=E.preview(s({vendorRegNo:'1111111111'}),[o({vendorRegNo:'2222222222'})],[],aliases,{manualOrderIds:['1']});
 assert.equal(p1.status,'NO_CANDIDATE');assert.equal(p1.rejected[0].reason,'사업자번호 충돌');
 const ledger=commit(s(),[o()]);
 const p2=E.preview(s({documentNo:'2'}),[o()],ledger);
 assert.equal(p2.status,'NO_CANDIDATE');assert.equal(p2.rejected[0].reason,'잔량 없음(이미 전부 배분됨)');
 const p3=E.preview(s({unit:'m'}),[o()],[],aliases,{manualOrderIds:['1']});
 assert.equal(p3.rejected[0].reason,'단위 종류 불일치(중량/길이/개수)');
});
test('commit이 무조건 거부하는 조건은 hardBlocked로 표시되고 검토 확인으로 우회 불가',()=>{
 const p=E.preview(s({unit:'',date:'2026-02-30'}),[o({unit:'',orderDate:'',requestDate:''})]);
 assert.deepEqual(p.hardBlocked,['매각일 누락 또는 오류','매각 단위 확인 필요']);
 assert.deepEqual(p.candidates[0].hardBlocked,['단위 확인 필요','발주/접수일 확인 필요']);
 assert.deepEqual(E.preview(s(),[o()]).hardBlocked,[]);assert.deepEqual(E.preview(s(),[o()]).candidates[0].hardBlocked,[]);
 assert.ok(E.preview(s({item:'M210'}),[o({item:'M-210'})]).candidates[0].hardBlocked.includes('M-210 행선지 확인 필요'));
});
test('완료 후 60일 넘은 발주만 확인 요청 — 최근 입고 완료 건은 그대로 READY',()=>{
 const fresh=E.preview(s({date:'2026-09-07'}),[o({done:true,inDate:'2026-09-02'})]);
 assert.equal(fresh.status,'READY');assert.equal(fresh.candidates[0].staleDone,false);
 const stale=E.preview(s({date:'2026-09-07'}),[o({done:true,inDate:'2026-06-01',orderDate:'2026-05-30'})]);
 assert.equal(stale.status,'REVIEW');assert.equal(stale.candidates[0].staleDone,true);
 assert.ok(stale.candidates[0].issues[0].includes('60일'));
 assert.strictEqual(E.preview(s(),[o({done:true})]).candidates[0].staleDone,false);   // 완료일 없으면 판단 불가 → false(빈 문자열 아님)
 assert.strictEqual(E.preview(s({date:'2026-09-07'}),[o({done:true,outDate:'2026-06-01',orderDate:'2026-05-30'})]).candidates[0].staleDone,true);   // 발주인데 출고일만 있는 경우도 완료일로 봄
 assert.equal(E.orderStart(o()),'2026-09-01');assert.equal(E.orderStart(o({action:'직접출고'})),'2026-08-31');
});
test('매각일이 발주일보다 앞서면 자동은 제외(사유 기록), 직접 지정은 경고 issue로 통과',()=>{
 const p=E.preview(s({date:'2026-08-01'}),[o()]);
 assert.equal(p.status,'NO_CANDIDATE');assert.equal(p.rejected[0].reason,'매각일이 발주/접수일보다 앞섬');
 const m=E.preview(s({date:'2026-08-01'}),[o()],[],aliases,{manualOrderIds:['1']});
 assert.equal(m.candidates.length,1);assert.ok(m.candidates[0].issues.includes('매각일이 발주/접수일보다 앞섬'));
});
test('M210 행선지는 검토 버튼만으로 우회 불가',()=>{
 const sale=s({item:'M210'}),orders=[o({item:'M-210'})];
 // 반영 불가 후보는 제안에 오르지 않으므로(REVIEW, 제안 없음) 배분을 직접 지정해도 막혀야 함
 const p=E.preview(sale,orders);
 assert.equal(p.status,'REVIEW');assert.equal(p.proposal.length,0);
 assert.throws(()=>commit(sale,orders,[],{reviewConfirmed:true,reviewReason:'확인',allocations:[{orderId:'1',baseQty:1000}]}),/행선지/);
});
test('M210: 사급 건에 확인·행선지가 모두 있으면 반영 가능, 매각 행선지는 있을 때만 대조',()=>{
 const ok=o({item:'M-210',m210Confirmed:true,destination:'울산공장'});
 assert.equal(E.preview(s({item:'M210'}),[ok]).status,'READY');   // 매각 행 행선지 없음(현재 앱) → 필수 아님
 assert.equal(commit(s({item:'M210'}),[ok]).length,1);
 for(const partial of [o({item:'M-210',m210Confirmed:true}),o({item:'M-210',destination:'울산공장'})])
  assert.ok(E.preview(s({item:'M210'}),[partial]).candidates[0].hardBlocked.includes('M-210 행선지 확인 필요'));
 assert.equal(E.preview(s({item:'M210',destination:'울산 공장'}),[ok]).status,'READY');   // 표기 차이(공백)는 같은 행선지
 const p=E.preview(s({item:'M210',destination:'대구공장'}),[ok]);
 assert.equal(p.status,'NO_CANDIDATE');assert.equal(p.rejected[0].reason,'행선지 불일치');
});
test('배분 취소는 삭제 없이 반영량 복원',()=>{
 const ledger=commit(s(),[o()]),rev=E.reverse(ledger,'e1','담당자','2026-09-09T00:00:00Z','잘못 선택');
 assert.equal(E.remainingOrder(o(),rev),1000);assert.equal(ledger[0].reversedAt,null);
 assert.equal(E.preview(s(),[o()],rev).status,'READY');
});
test('전표행 없는 파일은 내용 키(업체·품목·수량·매각일)+순번으로 식별 — 다른 파일로 재업로드해도 기존 반영',()=>{
 const [sale]=E.withContentOrdinals([s({documentNo:'',documentLine:''})]);
 assert.equal(sale.contentOrdinal,1);assert.equal(JSON.parse(E.sourceKey(sale))[0],'content');
 const p=E.preview(sale,[o()]);assert.equal(p.status,'READY');assert.deepEqual(p.issues,[]);
 const ledger=commit(sale,[o()]);
 // 재출력·다시 저장·행 밀림은 내용이 같으므로 같은 키 → 남은 다른 발주가 있어도 재배분하지 않음
 const [again]=E.withContentOrdinals([s({documentNo:'',documentLine:''})]);
 assert.equal(E.preview(again,[o(),o({id:'2'})],ledger).status,'ALREADY_LINKED');
 // 업체·품목 표기만 다른 재발행(법인 표기, 창고 위치 접미)도 같은 키
 const [spelled]=E.withContentOrdinals([s({documentNo:'',documentLine:'',vendor:'(주)동부엔지니어링',item:'IF850 15동 3열',unit:'KG'})]);
 assert.equal(E.sourceKey(spelled),E.sourceKey(sale));
 assert.equal(E.preview(spelled,[o(),o({id:'2'})],ledger).status,'ALREADY_LINKED');
});
test('전표번호만 있고 행번호가 없으면 내용 키로 식별 — 전표번호 열 유무·사업자번호 열 유무가 달라도 같은 키',()=>{
 const [a]=E.withContentOrdinals([s({documentNo:'D1',documentLine:''})]);
 const [b]=E.withContentOrdinals([s({documentNo:'',documentLine:'',vendorRegNo:'1234567890',itemCode:'A1'})]);
 assert.equal(JSON.parse(E.sourceKey(a))[0],'content');assert.equal(E.sourceKey(a),E.sourceKey(b));
 const ledger=commit(a,[o()]);
 assert.equal(E.preview(b,[o(),o({id:'2'})],ledger).status,'ALREADY_LINKED');
});
test('전표행 키로 반영한 건을 행번호 열 없이 다시 올려도 기존 반영(모든 이력에 내용 키 병행 저장)',()=>{
 const [withLine]=E.withContentOrdinals([s()]);
 const ledger=commit(withLine,[o()]);
 assert.equal(JSON.parse(ledger[0].sourceKey)[0],'transaction');assert.equal(ledger[0].contentOrdinal,1);
 const [noLine]=E.withContentOrdinals([s({documentLine:''})]);
 const p=E.preview(noLine,[o(),o({id:'2'})],ledger);
 assert.equal(p.status,'ALREADY_LINKED');assert.ok(p.issues[0].includes('전표행이 아니라'));
 assert.deepEqual(E.preview(withLine,[o(),o({id:'2'})],ledger).issues,[]);   // 전표행으로 잡히면 안내 없음
 // 같은 전표행의 수량 정정은 여전히 정정 필요
 assert.equal(E.preview(E.withContentOrdinals([s({qty:2000})])[0],[o(),o({id:'2'})],ledger).status,'SOURCE_CHANGED');
});
test('같은 파일 안의 같은 날 같은 품목 수량 다른 2행은 순서대로 반영돼도 중복 의심이 아님(batchKeys)',()=>{
 const rows=E.withContentOrdinals([s({documentNo:'',documentLine:''}),s({documentNo:'',documentLine:'',qty:500})]);
 const batchKeys=rows.map(E.sourceKey), orders=[o(),o({id:'2',qty:500})];
 const l1=commit(rows[0],orders,[],{batchKeys});
 const p=E.preview(rows[1],orders,l1,aliases,{batchKeys});
 assert.equal(p.status,'READY');assert.equal(p.duplicateSuspect,false);
 const l2=commit(rows[1],orders,l1,{eventId:'e2',batchKeys});
 assert.equal(l2.length,2);
 // batchKeys 없이 보면(다른 파일에서 온 500 행) 중복 의심
 assert.equal(E.preview(rows[1],orders,l1).duplicateSuspect,true);
});
test('같은 파일 안의 동일 내용 2행은 순번으로 별개 거래',()=>{
 const rows=E.withContentOrdinals([s({documentNo:'',documentLine:''}),s({documentNo:'',documentLine:''})]);
 assert.deepEqual(rows.map(r=>r.contentOrdinal),[1,2]);assert.notEqual(E.sourceKey(rows[0]),E.sourceKey(rows[1]));
 const orders=[o(),o({id:'2'})];
 const l1=commit(rows[0],[o()]);   // 1행 → 발주 1
 assert.equal(E.preview(rows[1],orders,l1).status,'READY');   // 2행 → 남은 발주 2
 const l2=commit(rows[1],orders,l1,{eventId:'e2'});
 assert.equal(E.remainingOrder(orders[0],l2)+E.remainingOrder(orders[1],l2),0);
 // 두 행 파일 재업로드 → 둘 다 기존 반영
 assert.deepEqual(E.withContentOrdinals([s({documentNo:'',documentLine:''}),s({documentNo:'',documentLine:''})]).map(r=>E.preview(r,orders,l2).status),['ALREADY_LINKED','ALREADY_LINKED']);
});
test('같은 날 같은 품목의 기존 반영과 수량이 다르면 중복 의심으로 표시하고 검토 사유 요구',()=>{
 const ledger=commit(E.withContentOrdinals([s({documentNo:'',documentLine:''})])[0],[o()]);
 const [changed]=E.withContentOrdinals([s({documentNo:'',documentLine:'',qty:900})]);
 const p=E.preview(changed,[o(),o({id:'2'})],ledger);
 assert.equal(p.duplicateSuspect,true);assert.notEqual(p.status,'READY');assert.ok(p.issues[0].includes('수량 다름'));
 assert.throws(()=>commit(changed,[o(),o({id:'2'})],ledger,{eventId:'e2'}),/검토/);
 // 다른 날짜면 의심 아님; 전표행 키가 있으면 전표가 진실이므로 의심 표시 없음
 assert.equal(E.preview(E.withContentOrdinals([s({documentNo:'',documentLine:'',qty:900,date:'2026-09-08'})])[0],[o({id:'2'})],ledger).duplicateSuspect,false);
 assert.equal(E.preview(s({documentNo:'2',qty:900}),[o({id:'2'})],ledger).duplicateSuspect,false);
});
test('예전 file-row 키 원장은 스냅샷으로 내용 키를 붙여 재업로드를 기존 반영으로 인식',()=>{
 const legacy=[{id:'L1',version:1,sourceKey:JSON.stringify(['file-row','a'.repeat(64),0,4]),sourceSnapshot:E.sourceSnapshot(s()),
  actor:'x',createdAt:'2026-09-01T00:00:00',reviewReason:'r',allocations:[{orderId:'1',baseQty:1000}],reversedAt:null},
  {id:'L2',version:1,sourceKey:JSON.stringify(['file-row','b'.repeat(64),0,4]),sourceSnapshot:E.sourceSnapshot(s()),
  actor:'x',createdAt:'2026-09-02T00:00:00',reviewReason:'r',allocations:[{orderId:'2',baseQty:1000}],reversedAt:null},
  {id:'L3',version:1,sourceKey:JSON.stringify(['file-row','c'.repeat(64),0,4]),sourceSnapshot:E.sourceSnapshot(s()),
  actor:'x',createdAt:'2026-09-03T00:00:00',reviewReason:'r',allocations:[{orderId:'3',baseQty:1000}],reversedAt:'2026-09-04T00:00:00'}];
 const m=E.migrateLedger(legacy);
 assert.equal(m[0].contentOrdinal,1);assert.equal(m[1].contentOrdinal,2);assert.equal(m[2].contentOrdinal,undefined);
 assert.equal(m[0].sourceKey,legacy[0].sourceKey);assert.strictEqual(E.migrateLedger(m),m);   // 원본 키 보존, 할 일 없으면 같은 배열 반환
 // 일부만 마이그레이션된 원장(다른 기기가 먼저 저장)도 순번이 겹치지 않음
 const mixed=[m[0],legacy[1]];const m2=E.migrateLedger(mixed);
 assert.equal(m2[1].contentOrdinal,2);
 const sale=E.withContentOrdinals([s({documentNo:'',documentLine:''})])[0];
 assert.equal(E.preview(sale,[o(),o({id:'2'}),o({id:'3'})],m).status,'ALREADY_LINKED');
 assert.equal(E.preview(sale,[o(),o({id:'2'}),o({id:'3'})],legacy).status,'READY');   // 마이그레이션 전에는 새 건으로 보임(문제 재현)
});
test('전표행 키 행은 자기 전표행만 조회 — 같은 내용의 다른 전표와 순번이 겹쳐도 합산·오판 없음',()=>{
 const rows=E.withContentOrdinals([s({documentNo:'D1'}),s({documentNo:'D2'})]);
 const orders=[o(),o({id:'2'})];
 const l1=commit(rows[0],[o()]);const l2=commit(rows[1],[o({id:'2'})],l1,{eventId:'e2'});
 // 파일에 D2만 있는 재업로드(순번 1) → D1과 합산되지 않고 D2 기존 반영
 const [onlyD2]=E.withContentOrdinals([s({documentNo:'D2'})]);
 const p=E.preview(onlyD2,orders,l2);assert.equal(p.status,'ALREADY_LINKED');assert.equal(p.linkedByContent,false);assert.deepEqual(p.issues,[]);
 // 내용이 같은 새 전표 D9(순번 1)는 기존 전표에 묶이지 않고 새 건
 const [d9]=E.withContentOrdinals([s({documentNo:'D9'})]);
 assert.equal(E.preview(d9,[...orders,o({id:'3'})],l2).status,'READY');
});
test('전표행 이력이 원장 순서와 파일 순서가 달라도 재업로드는 모두 기존 반영',()=>{
 const rows=E.withContentOrdinals([s({documentNo:'D1'}),s({documentNo:'D2'})]);
 const legacy=[rows[1],rows[0]].map((r,i)=>({id:'L'+i,version:1,sourceKey:E.sourceKey(r),sourceSnapshot:E.sourceSnapshot(r),actor:'x',createdAt:'2026-09-0'+(i+1),reviewReason:'',allocations:[{orderId:String(i+1),baseQty:1000}],reversedAt:null}));
 const m=E.migrateLedger(legacy);
 assert.deepEqual(rows.map(r=>E.preview(r,[o(),o({id:'2'}),o({id:'3'})],m).status),['ALREADY_LINKED','ALREADY_LINKED']);
});
test('별개 거래로 반영(separateSale): 내용이 같은 기존 반영이 있어도 다음 순번으로 새 건 처리, 사유 필수',()=>{
 const orders=[o(),o({id:'2'})];
 const [x]=E.withContentOrdinals([s({documentNo:'',documentLine:''})]);
 const l1=commit(x,[o()]);
 const linked=E.preview(x,orders,l1);assert.equal(linked.status,'ALREADY_LINKED');assert.equal(linked.linkedByContent,true);
 const x2={...x,contentOrdinal:E.nextFreeOrdinal(x,l1)};assert.equal(x2.contentOrdinal,2);   // 앱이 선언 시 1회 확정
 const sep=E.preview(x2,orders,l1,aliases,{separateSale:true});
 assert.equal(sep.status,'REVIEW');assert.equal(sep.contentOrdinal,2);assert.ok(sep.issues[0].includes('별개 거래'));
 assert.throws(()=>commit(x2,orders,l1,{eventId:'e2',separateSale:true,allocations:sep.proposal}),/검토/);
 const l2=commit(x2,orders,l1,{eventId:'e2',separateSale:true,allocations:sep.proposal,reviewConfirmed:true,reviewReason:'같은 날 2회 출하'});
 assert.equal(l2[1].contentOrdinal,2);
 // 자기 전표행이 이미 반영된 전표행 키 행은 separateSale과 무관하게 기존 반영
 assert.equal(E.preview(E.withContentOrdinals([s()])[0],[o()],commit(E.withContentOrdinals([s()])[0],[o()]),aliases,{separateSale:true}).status,'ALREADY_LINKED');
 // 이후 두 행이 든 파일 재업로드 → 둘 다 기존 반영
 assert.deepEqual(E.withContentOrdinals([s({documentNo:'',documentLine:''}),s({documentNo:'',documentLine:''})]).map(r=>E.preview(r,orders,l2).status),['ALREADY_LINKED','ALREADY_LINKED']);
});
test('내용은 같아도 사업자번호·품목코드가 서로 다르면 같은 매각으로 묶지 않음',()=>{
 const [a]=E.withContentOrdinals([s({documentNo:'',documentLine:'',vendorRegNo:'1111111111'})]);
 const ledger=commit(a,[o()]);
 const [b]=E.withContentOrdinals([s({documentNo:'',documentLine:'',vendorRegNo:'2222222222'})]);
 assert.equal(E.preview(b,[o({id:'2'})],ledger).status,'READY');
 const [c]=E.withContentOrdinals([s({documentNo:'',documentLine:'',vendorRegNo:'1111111111'})]);
 assert.equal(E.preview(c,[o({id:'2'})],ledger).status,'ALREADY_LINKED');
 const [d]=E.withContentOrdinals([s({documentNo:'',documentLine:'',itemCode:'A1'})]);
 const l2=commit(d,[o()]);
 assert.equal(E.preview(E.withContentOrdinals([s({documentNo:'',documentLine:'',itemCode:'B1'})])[0],[o({id:'2'})],l2).status,'READY');
});
test('마이그레이션은 정수가 아닌 순번을 무시하고 정수 순번만 이어감',()=>{
 const bad={id:'B',version:1,sourceKey:JSON.stringify(['content','TEST',E.contentTuple(s()),1]),contentOrdinal:'1',sourceSnapshot:E.sourceSnapshot(s()),actor:'x',createdAt:'2026-09-01',reviewReason:'',allocations:[],reversedAt:null};
 const legacy={id:'L',version:1,sourceKey:JSON.stringify(['file-row','a'.repeat(64),0,1]),sourceSnapshot:E.sourceSnapshot(s()),actor:'x',createdAt:'2026-09-02',reviewReason:'',allocations:[{orderId:'1',baseQty:1000}],reversedAt:null};
 const m=E.migrateLedger([bad,legacy]);assert.equal(m[0].contentOrdinal,1);assert.equal(m[1].contentOrdinal,2);
});
test('저장된 키 문자열이 아니라 스냅샷에서 다시 계산한 내용으로 대조 — 키 문자열이 낡아도 기존 반영 인식',()=>{
 const [x]=E.withContentOrdinals([s({documentNo:'',documentLine:''})]);
 const ledger=commit(x,[o()]).map(e=>({...e,sourceKey:JSON.stringify(['content','TEST','옛 정규화 결과',1])}));
 assert.equal(E.preview(x,[o(),o({id:'2'})],ledger).status,'ALREADY_LINKED');
});
test('전표행 키 행도 [별개 거래]로 내용 대조를 건너뛰고 다음 순번으로 새 건 처리',()=>{
 const [x]=E.withContentOrdinals([s({documentNo:'',documentLine:''})]);
 const ledger=commit(x,[o()]);
 const [d3]=E.withContentOrdinals([s({documentNo:'D3'})]);
 const linked=E.preview(d3,[o(),o({id:'2'})],ledger);assert.equal(linked.status,'ALREADY_LINKED');assert.equal(linked.linkedByContent,true);
 const sep=E.preview(d3,[o(),o({id:'2'})],ledger,aliases,{separateSale:true});
 assert.equal(sep.status,'REVIEW');assert.equal(sep.contentOrdinal,2);
 const l2=commit(d3,[o(),o({id:'2'})],ledger,{eventId:'e2',separateSale:true,allocations:sep.proposal,reviewConfirmed:true,reviewReason:'별개 전표'});
 assert.equal(l2[1].contentOrdinal,2);
 assert.equal(E.preview(x,[o(),o({id:'2'})],l2).status,'ALREADY_LINKED');   // 원래 행 재업로드는 여전히 1건과만 대조(합산 없음)
});
test('부분 배분으로 이력이 2건인 매각은 마이그레이션 후에도 한 순번을 공유하고 재업로드는 기존 반영',()=>{
 const [x]=E.withContentOrdinals([s({documentNo:'',documentLine:''})]);
 const key=JSON.stringify(['file-row','a'.repeat(64),0,4]);
 const mk=(id,orderId,q)=>({id,version:1,sourceKey:key,sourceSnapshot:E.sourceSnapshot(x),actor:'x',createdAt:'2026-09-0'+id.slice(-1),reviewReason:'',allocations:[{orderId,baseQty:q}],reversedAt:null});
 const m=E.migrateLedger([mk('L1','1',600),mk('L2','2',400)]);
 assert.equal(m[0].contentOrdinal,1);assert.equal(m[1].contentOrdinal,1);
 assert.equal(E.preview(x,[o(),o({id:'2'}),o({id:'3'})],m).status,'ALREADY_LINKED');
 // 새 이력도 같은 매각의 두 번째 배분은 첫 배분과 같은 순번
 const orders=[o({qty:600}),o({id:'2',qty:400})];
 const p1=E.preview(x,orders,[]);
 const l1=E.commit({sale:x,orders,ledger:[],allocations:[{orderId:'1',baseQty:600}],actor:'t',now:'n',eventId:'a',expectedSourceSnapshot:p1.sourceSnapshot,expectedOrders:{1:E.orderSnapshot(orders[0]),2:E.orderSnapshot(orders[1])},reviewConfirmed:true,reviewReason:'부분'});
 const p2=E.preview(x,orders,l1);
 const l2=E.commit({sale:x,orders,ledger:l1,allocations:[{orderId:'2',baseQty:400}],actor:'t',now:'n',eventId:'b',expectedSourceSnapshot:p2.sourceSnapshot,expectedOrders:{1:E.orderSnapshot(orders[0]),2:E.orderSnapshot(orders[1])},reviewConfirmed:true,reviewReason:'부분'});
 assert.equal(l2[0].contentOrdinal,l2[1].contentOrdinal);
 assert.equal(E.preview(x,[...orders,o({id:'3'})],l2).status,'ALREADY_LINKED');
});
test('서로 다른 파일에서 온 같은 내용의 전표 2건을 행번호 없이 함께 재업로드해도 둘 다 기존 반영',()=>{
 const [d1]=E.withContentOrdinals([s({documentNo:'D1'})]);const [d2]=E.withContentOrdinals([s({documentNo:'D2'})]);
 const orders=[o(),o({id:'2'}),o({id:'3'})];
 const l1=commit(d1,[o()]);const l2=commit(d2,[o({id:'2'})],l1,{eventId:'e2'});
 assert.deepEqual(l2.map(e=>e.contentOrdinal),[1,2]);   // 전표행 이력의 순번은 파일이 아니라 원장 기준
 const rows=E.withContentOrdinals([s({documentNo:'',documentLine:''}),s({documentNo:'',documentLine:''})]);
 assert.deepEqual(rows.map(r=>E.preview(r,orders,l2).status),['ALREADY_LINKED','ALREADY_LINKED']);
 // 전표 순서를 바꿔 반영해도(D2 먼저) 순번은 빈 자리부터 채움
 const l3=commit(d1,[o()],commit(d2,[o({id:'2'})]),{eventId:'e2'});
 assert.deepEqual(l3.map(e=>e.contentOrdinal).sort(),[1,2]);
});
test('내용 기준으로 반영된 매각(부분 배분)을 행번호 열과 함께 다시 올리면 같은 순번을 이어받아 합산됨',()=>{
 const [x]=E.withContentOrdinals([s({documentNo:'',documentLine:''})]);
 const orders=[o({qty:600}),o({id:'2',qty:400}),o({id:'3'})];
 const p1=E.preview(x,orders,[]);
 const l1=E.commit({sale:x,orders,ledger:[],allocations:[{orderId:'1',baseQty:600}],actor:'t',now:'n',eventId:'a',expectedSourceSnapshot:p1.sourceSnapshot,expectedOrders:Object.fromEntries(orders.map(q=>[q.id,E.orderSnapshot(q)])),reviewConfirmed:true,reviewReason:'부분'});
 const [slip]=E.withContentOrdinals([s()]);   // 전표행 있음, 파일 순번 1
 const p2=E.preview(slip,orders,l1);assert.equal(p2.remaining,400);assert.equal(p2.contentOrdinal,1);
 const l2=E.commit({sale:slip,orders,ledger:l1,allocations:[{orderId:'2',baseQty:400}],actor:'t',now:'n',eventId:'b',expectedSourceSnapshot:p2.sourceSnapshot,expectedOrders:Object.fromEntries(orders.map(q=>[q.id,E.orderSnapshot(q)])),reviewConfirmed:true,reviewReason:'부분'});
 assert.equal(l2[1].contentOrdinal,1);
 assert.equal(E.preview(slip,orders,l2).status,'ALREADY_LINKED');   // 전표 형태 재업로드: 자기 전표행 400 + 내용 기준 이력 600 합산
 assert.equal(E.preview(x,orders,l2).status,'ALREADY_LINKED');      // 내용 형태 재업로드: 순번 1 이력 2건 합산 1000
});
test('별개 거래 순번은 선언 시 한 번 확정(nextFreeOrdinal)되고, 자기 키가 batchKeys에 있어도 미리보기·반영에서 흔들리지 않음',()=>{
 const rows=E.withContentOrdinals([s({documentNo:'',documentLine:''}),s({documentNo:'',documentLine:''})]);
 const orders=[o(),o({id:'2'}),o({id:'3'})];
 const l=commit(rows[1],[o({id:'2'})],commit(rows[0],[o()]),{eventId:'e2'});
 const a={...rows[0],contentOrdinal:E.nextFreeOrdinal(rows[0],l,[E.sourceKey(rows[1])])};
 assert.equal(a.contentOrdinal,3);
 const b={...rows[1],contentOrdinal:E.nextFreeOrdinal(rows[1],l,[E.sourceKey(a)])};
 assert.equal(b.contentOrdinal,4);
 const batchKeys=[E.sourceKey(a),E.sourceKey(b)];   // 실제 화면처럼 자기 키 포함
 const pa=E.preview(a,orders,l,aliases,{separateSale:true,batchKeys});
 assert.equal(pa.contentOrdinal,3);assert.equal(pa.status,'REVIEW');
 const la=E.commit({sale:a,orders,ledger:l,allocations:pa.proposal,actor:'t',now:'n',eventId:'e3',expectedSourceSnapshot:pa.sourceSnapshot,expectedOrders:Object.fromEntries(orders.map(q=>[q.id,E.orderSnapshot(q)])),reviewConfirmed:true,reviewReason:'별개',separateSale:true,batchKeys});
 assert.equal(la[2].contentOrdinal,3);
 assert.equal(E.preview(a,orders,la,aliases,{batchKeys}).status,'ALREADY_LINKED');   // 반영 후 플래그를 내리면 자기 이력(3번)과 대조
 const pb=E.preview(b,[...orders,o({id:'4'})],la,aliases,{separateSale:true,batchKeys});assert.equal(pb.contentOrdinal,4);assert.equal(pb.status,'REVIEW');
});
test('중복 의심은 사업자번호·품목코드가 다른 업체·품목에는 적용하지 않음',()=>{
 const [a]=E.withContentOrdinals([s({documentNo:'',documentLine:'',vendorRegNo:'1111111111'})]);
 const ledger=commit(a,[o()]);
 const [b]=E.withContentOrdinals([s({documentNo:'',documentLine:'',vendorRegNo:'2222222222',qty:900})]);
 assert.equal(E.preview(b,[o({id:'2'})],ledger).duplicateSuspect,false);
 const [c]=E.withContentOrdinals([s({documentNo:'',documentLine:'',qty:900})]);
 assert.equal(E.preview(c,[o({id:'2'})],ledger).duplicateSuspect,true);
});
test('㎏·ℓ·매 같은 엑셀 표기를 NFKC로 인식',()=>{
 assert.deepEqual(E.unit('㎏'),{family:'MASS',factor:1});
 assert.deepEqual(E.unit(' Kg '),{family:'MASS',factor:1});
 assert.deepEqual(E.unit('ℓ'),{family:'VOLUME',factor:1});
 assert.deepEqual(E.unit('㎖'),{family:'VOLUME',factor:0.001});
 assert.deepEqual(E.unit('매'),{family:'COUNT',factor:1});
 assert.equal(E.unit('포').family,'PACK');
 assert.equal(E.unit('포대기'),null);
 assert.equal(E.preview(s({unit:'㎏'}),[o()]).status,'READY');
});
test('미인식 단위는 값이 문구에 표시되고 빈 단위 문구는 그대로',()=>{
 const p=E.preview(s({unit:'포대기'}),[o()]);
 assert.deepEqual(p.hardBlocked,['매각 단위 확인 필요(미인식 "포대기")']);
 assert.deepEqual(E.preview(s({unit:''}),[o()]).hardBlocked,['매각 단위 확인 필요']);
 assert.deepEqual(E.preview(s(),[o({unit:'포대기'})]).candidates[0].hardBlocked,['발주/출고 단위 확인 필요(미인식 "포대기")']);
});
test('포장 단위는 기준정보 kg 환산이 있을 때만 중량으로 비교',()=>{
 const calls=[];const packKgOf=(item,unit)=>{calls.push(unit);return /IF/.test(item)?25:null;};
 const p=E.preview(s({qty:40,unit:'포'}),[o()],[],aliases,{packKgOf});
 assert.equal(p.status,'READY');assert.equal(p.proposal[0].baseQty,1000);
 assert.equal(p.salePackKg,25);assert.equal(p.candidates[0].packKg,null);
 assert.deepEqual(calls,['포']);   // kg 쪽은 기준정보를 조회하지 않음(단위가 포장 단위일 때만, 품목별 1회)
 const ledger=commit(s({qty:40,unit:'포'}),[o()],[],{packKgOf});
 assert.equal(ledger[0].allocations[0].baseQty,1000);
 assert.equal(E.preview(s({qty:40,unit:'포'}),[o()],ledger,aliases,{packKgOf}).status,'ALREADY_LINKED');
 // 반영 뒤 기준정보 환산값이 바뀌면 조용히 잔량이 바뀌지 않고 자료 변경으로 막힘
 assert.equal(E.preview(s({qty:40,unit:'포'}),[o()],ledger,aliases,{packKgOf:()=>30}).status,'SOURCE_CHANGED');
 // 미리보기 뒤 사급 쪽 환산값이 바뀌어도 반영이 거부됨
 const q0=E.preview(s({qty:500}),[o({qty:20,unit:'BOX'})],[],aliases,{packKgOf});
 assert.throws(()=>E.commit({sale:s({qty:500}),orders:[o({qty:20,unit:'BOX'})],ledger:[],aliases,allocations:q0.proposal,actor:'t',now:'2026-09-08T00:00:00Z',eventId:'e8',
  expectedOrders:{'1':q0.candidates[0].orderSnapshot},expectedSourceSnapshot:q0.sourceSnapshot,packKgOf:()=>30,reviewConfirmed:true,reviewReason:'확인'}),/미리보기 이후 대상 변경/);
 // 환산이 없는 기존 스냅샷 형식은 그대로(이전 원장과 호환)
 assert.equal(E.sourceSnapshot(s()),E.sourceSnapshot(s(),null));assert.equal(E.orderSnapshot(o()),E.orderSnapshot(o(),null));
 // 사급 쪽이 포장 단위여도 같은 환산으로 잔량 계산
 const q=E.preview(s({qty:500}),[o({qty:20,unit:'BOX'})],[],aliases,{packKgOf});
 assert.equal(q.status,'READY');assert.equal(q.candidates[0].remaining,500);
 // 환산 정보가 없으면 반영 불가(하드블록)로 안내
 const none=E.preview(s({qty:40,unit:'포'}),[o()]);
 assert.deepEqual(none.hardBlocked,['매각 포장 단위(포) 환산 정보 필요 — 기준정보에 품목 포장 kg 입력']);
 assert.throws(()=>commit(s({qty:40,unit:'포'}),[o()],[],{reviewConfirmed:true,reviewReason:'확인'}),/원천 단위/);
 const noneOrder=E.preview(s({qty:500}),[o({qty:20,unit:'BOX'})]);
 assert.equal(noneOrder.candidates[0].hardBlocked[0],'발주/출고 포장 단위(BOX) 환산 정보 필요 — 기준정보에 품목 포장 kg 입력');
 // 환산값이 사라진 뒤에도(원장에 kg 배분이 있는 상태) "잔량 없음"으로 조용히 빠지지 않고 환산 정보 안내가 남음
 const boxLedger=commit(s({qty:500}),[o({qty:20,unit:'BOX'})],[],{packKgOf});
 const gone=E.preview(s({qty:500,documentNo:'2'}),[o({qty:20,unit:'BOX'})],boxLedger);
 assert.equal(gone.rejected.length,0);assert.equal(gone.candidates[0].hardBlocked[0],'발주/출고 포장 단위(BOX) 환산 정보 필요 — 기준정보에 품목 포장 kg 입력');
 assert.throws(()=>E.commit({sale:s({qty:500}),orders:[o({qty:20,unit:'BOX'})],ledger:[],aliases,allocations:[{orderId:'1',baseQty:20}],actor:'t',now:'2026-09-08T00:00:00Z',eventId:'e9',
  expectedOrders:{'1':E.orderSnapshot(o({qty:20,unit:'BOX'}))},expectedSourceSnapshot:E.sourceSnapshot(s({qty:500})),reviewConfirmed:true,reviewReason:'확인'}),/발주\/출고 단위/);
});
test('kg↔L는 후보로 남되 자동 제안 없이 검토, 반영 시 매각 소진 수량 필수',()=>{
 const sale=s({qty:900,unit:'L'});
 const p=E.preview(sale,[o()]);
 assert.equal(p.status,'REVIEW');assert.equal(p.proposal.length,0);
 assert.equal(p.candidates[0].crossFamily,true);assert.equal(p.candidates[0].quantityDifference,null);
 assert.ok(p.candidates[0].issues.some(i=>/kg↔L|L↔kg/.test(i)));
 assert.deepEqual(p.hardBlocked,[]);assert.deepEqual(p.candidates[0].hardBlocked,[]);
 const args=extra=>({sale,orders:[o()],ledger:[],aliases,actor:'t',now:'2026-09-08T00:00:00Z',eventId:'e2',
  expectedOrders:{'1':E.orderSnapshot(o())},expectedSourceSnapshot:E.sourceSnapshot(sale),reviewConfirmed:true,reviewReason:'밀도 확인',...extra});
 assert.throws(()=>E.commit(args({allocations:[{orderId:'1',baseQty:1000}]})),/매각 소진 수량/);
 assert.throws(()=>E.commit(args({allocations:[{orderId:'1',baseQty:1000,saleQty:950}]})),/매각 잔량 초과/);
 const ledger=E.commit(args({allocations:[{orderId:'1',baseQty:1000,saleQty:900}]}));
 assert.deepEqual(ledger[0].allocations,[{orderId:'1',baseQty:1000,saleQty:900,saleBaseQty:900}]);
 assert.equal(E.preview(sale,[o()],ledger).status,'ALREADY_LINKED');
 assert.equal(E.remainingOrder(o(),ledger),0);
 // 매각 소진량은 매각 파일의 단위 그대로 적음(1톤) — 원장에는 기준 척도(1,000kg)로 함께 저장
 const ton=s({qty:1,unit:'톤'}), lo=o({unit:'L'});
 const tl=E.commit({sale:ton,orders:[lo],ledger:[],aliases,actor:'t',now:'2026-09-08T00:00:00Z',eventId:'e3',expectedOrders:{'1':E.orderSnapshot(lo)},
  expectedSourceSnapshot:E.sourceSnapshot(ton),reviewConfirmed:true,reviewReason:'밀도 확인',allocations:[{orderId:'1',baseQty:1000,saleQty:1}]});
 assert.equal(tl[0].allocations[0].saleBaseQty,1000);
 assert.equal(E.preview(ton,[lo],tl).status,'ALREADY_LINKED');
 assert.equal(E.baseFactor('톤'),1000);assert.equal(E.baseFactor('포'),null);assert.equal(E.baseFactor('포',25),25);
 // 길이↔중량, 개수↔중량은 여전히 제외
 assert.equal(E.preview(s({unit:'EA'}),[o()]).status,'NO_CANDIDATE');
 // 같은 계열 배분에 saleQty를 넣어도 원장에는 저장하지 않음
 const same=commit(s(),[o()],[],{});
 assert.deepEqual(Object.keys(same[0].allocations[0]),['orderId','baseQty']);
});
test('전표행 행은 전표행 없이 반영된 같은 내용 이력이 딱 1건일 때만 잇고, 여러 건이면 확인 요청',()=>{
 const orders=[o(),o({id:'2'}),o({id:'3'}),o({id:'4'})];
 // 내용 기준으로 2건(순번 1·2) 반영
 const rows=E.withContentOrdinals([s({documentNo:'',documentLine:''}),s({documentNo:'',documentLine:''})]);
 const l=commit(rows[1],[o({id:'2'})],commit(rows[0],[o()]),{eventId:'e2'});
 // 전표 D1(파일 순번 1): 어느 이력인지 알 수 없음 → 잇지 않고 확인 요청, 자동 배분 제외
 const [d1]=E.withContentOrdinals([s({documentNo:'D1'})]);
 const p=E.preview(d1,orders,l);
 assert.equal(p.duplicateSuspect,true);assert.equal(p.linkedByContent,true);assert.ok(p.issues[0].includes('2건'));assert.notEqual(p.status,'READY');
 // 1건만 남으면 순번과 무관하게 그 건에 이음: 전표 D9가 순번 1 이력을 가져간 뒤 D1은 남은 순번 2 이력과 연결
 const [d9]=E.withContentOrdinals([s({documentNo:'D9'})]);
 const lOne=[l[0],{...l[1],reversedAt:'x'}];
 assert.equal(E.preview(d9,orders,lOne).status,'ALREADY_LINKED');
 // 혼합 시나리오(코드리뷰): D2만 전표로 반영(순번 1) → 내용 파일 2행 재업로드(1행 기존, 2행 새로 순번 2) → 전표 파일 재업로드 시 D1·D2 모두 기존 반영
 const [dd1,dd2]=E.withContentOrdinals([s({documentNo:'D1'}),s({documentNo:'D2'})]);
 const m1=commit(dd2,[o()]);
 const cr=E.withContentOrdinals([s({documentNo:'',documentLine:''}),s({documentNo:'',documentLine:''})]);
 assert.equal(E.preview(cr[0],orders,m1).status,'ALREADY_LINKED');
 const m2=commit(cr[1],[o({id:'2'})],m1,{eventId:'e2'});
 assert.deepEqual([dd1,dd2].map(r=>E.preview(r,orders,m2).status),['ALREADY_LINKED','ALREADY_LINKED']);
});
test('별개 거래 순번이 반영 직전 다른 반영에 쓰였으면 반영 불가(SOURCE_CHANGED)',()=>{
 const [x]=E.withContentOrdinals([s({documentNo:'',documentLine:''})]);
 const l1=commit(x,[o()]);
 const x2={...x,contentOrdinal:E.nextFreeOrdinal(x,l1)};
 const l2=commit(x2,[o({id:'2'})],l1,{eventId:'e2',separateSale:true,reviewConfirmed:true,reviewReason:'별개'});   // 다른 기기가 먼저 순번 2 사용
 const p=E.preview(x2,[o({id:'3'})],l2,aliases,{separateSale:true});
 assert.equal(p.status,'SOURCE_CHANGED');
 assert.throws(()=>commit(x2,[o({id:'3'})],l2,{eventId:'e3',separateSale:true,reviewConfirmed:true,reviewReason:'별개'}),/SOURCE_CHANGED/);
});

test('반영 불가(단위 빈칸) 후보는 제안에서 빠지고, 같은 수량의 정상 후보가 제안됨',()=>{
 const orders=[o({id:'9',unit:'',orderDate:'2026-09-01'}),o({id:'2',orderDate:'2026-09-02'})];   // 9가 더 오래됐지만 단위 빈칸
 const p=E.preview(s(),orders);
 assert.equal(p.status,'READY');assert.deepEqual(p.proposal.map(a=>String(a.orderId)),['2']);
 assert.ok(p.candidates.find(c=>c.orderId==='9').hardBlocked.length);   // 후보 목록에는 남아 이유가 보임
 // 후보 전부가 반영 불가면 수량 문제가 아니라 자료 보완 문제 → REVIEW
 const q=E.preview(s(),[o({id:'9',unit:''})]);
 assert.equal(q.status,'REVIEW');assert.equal(q.proposal.length,0);
});

test('선입선출 동률에서 완료 후 오래된(확인 사항) 후보보다 깨끗한 후보를 먼저 제안',()=>{
 const stale=o({id:'A',done:true,inDate:'2026-05-01',orderDate:'2026-04-20'}),fresh=o({id:'B',orderDate:'2026-09-01'});
 const p=E.preview(s({date:'2026-09-07'}),[stale,fresh]);
 assert.equal(p.status,'READY');assert.deepEqual(p.proposal.map(a=>String(a.orderId)),['B']);
 assert.ok(p.candidates.find(c=>c.orderId==='A').staleDone);
});
test('정확히 맞는 후보가 반영 불가뿐이면 수량 확인이 아니라 검토 필요(자료 보완)',()=>{
 const p=E.preview(s(),[o({id:'A',unit:''}),o({id:'B',qty:2000})]);
 assert.equal(p.status,'REVIEW');assert.equal(p.proposal.length,0);
 assert.ok(p.candidates.find(c=>c.orderId==='A').hardBlocked.length);
 // 반영 불가 후보를 빼도 정확히 맞는 조합이 없으면 종전대로 수량 확인
 assert.equal(E.preview(s({qty:1500}),[o({id:'A',unit:''}),o({id:'B',qty:2000})]).status,'QUANTITY_REVIEW');
});

test('반영 불가 후보를 더해도 후보가 상한을 넘으면 자료 보완이 아니라 종전 판정(REVIEW/수량 확인) 유지',()=>{
 const many=Array.from({length:E.SUBSET_CAP},(_,i)=>o({id:String(i+1),qty:700}));   // 정확히 맞는 조합 없음
 assert.equal(E.preview(s({qty:1000}),many).status,'QUANTITY_REVIEW');
 assert.equal(E.preview(s({qty:1000}),[...many,o({id:'X',unit:''})]).status,'QUANTITY_REVIEW');   // 13건째가 반영 불가 → too_many는 "맞는 조합 있음"이 아님
 assert.ok(E.orderRank({start:'2026-09-01',orderId:'9'})<E.orderRank({start:'2026-09-01',orderId:'10'}));
 assert.ok(E.orderRank({start:'2026-09-09',orderId:'2',done:false})<E.orderRank({start:'2026-09-01',orderId:'1',done:true}));   // 미완료가 날짜와 무관하게 먼저
});

test('같은 수량의 완료 건(60일 이내)과 열린 발주가 함께 있으면 열린 발주부터 제안(2026-09-23 결정)',()=>{
 const done=o({id:'44',done:true,inDate:'2026-09-01',orderDate:'2026-08-26'}),open=o({id:'338',orderDate:'2026-09-09'});
 const p=E.preview(s({date:'2026-09-20'}),[done,open]);
 assert.equal(p.status,'READY');assert.equal(p.subsetKind,'fifo');
 assert.deepEqual(p.proposal.map(a=>String(a.orderId)),['338']);
 assert.ok(!p.candidates.find(c=>c.orderId==='44').staleDone);   // 확인 사항이 아니라 순위로만 밀림
 // 열린 발주를 다 쓰면 완료 건이 다음 순서
 const ledger=[{id:'x',version:E.VERSION,sourceKey:'k',sourceSnapshot:'{}',allocations:[{orderId:'338',baseQty:1000}],reversedAt:null}];
 assert.deepEqual(E.preview(s({date:'2026-09-20'}),[done,open],ledger).proposal.map(a=>String(a.orderId)),['44']);
 // 조합끼리도 열린 발주로만 된 조합 우선 — 열린 9/5 1000+9/9 2000 vs 완료 8/26 3000
 const r=E.preview(s({qty:3000,date:'2026-09-20'}),[o({id:'D',done:true,inDate:'2026-09-01',orderDate:'2026-08-26',qty:3000}),o({id:'A',orderDate:'2026-09-05',qty:1000}),o({id:'B',orderDate:'2026-09-09',qty:2000})]);
 assert.deepEqual(r.proposal.map(a=>String(a.orderId)).sort(),['A','B']);
});
