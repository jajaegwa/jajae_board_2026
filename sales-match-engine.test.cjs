const {test}=require('node:test');
const assert=require('node:assert/strict');
const E=require('./sales-match-engine.js');
const aliases=require('./alias-candidates.json');
const s=(x={})=>({sourceSystem:'TEST',issuerId:'TEST',documentNo:'1',documentLine:'1',vendor:'동부엔지니어링',item:'IF850',qty:1000,unit:'kg',date:'2026-09-07',...x});
const o=(x={})=>({id:'1',action:'발주',vendor:'동부엔지니어링',item:'IF-850',qty:1000,unit:'kg',orderDate:'2026-09-01',requestDate:'2026-08-31',done:false,...x});
function commit(sale,orders,ledger=[],extra={}) {
 const p=E.preview(sale,orders,ledger,aliases,{packKgOf:extra.packKgOf,manualOrderIds:extra.manualOrderIds});
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
test('1000 세 건 중 2000 선택은 모호함',()=>{
 const p=E.preview(s({qty:2000}),[o(),o({id:'2'}),o({id:'3'})]);
 assert.equal(p.status,'AMBIGUOUS');assert.equal(p.proposal.length,0);
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
test('파일명/행번호만 있는 자료는 자동 확정 불가',()=>{
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
 assert.throws(()=>commit(sale,orders,[],{reviewConfirmed:true,reviewReason:'확인'}),/행선지/);
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
test('전표 없는 파일은 SHA256+시트+원본행으로 검토 후 연결 가능',()=>{
 const sale=s({documentNo:'',importBatchHash:'a'.repeat(64),sheetIndex:0,sourceRowIndex:4});
 assert.equal(E.preview(sale,[o()]).status,'REVIEW');
 assert.throws(()=>commit(sale,[o()]),/검토/);
 const ledger=commit(sale,[o()],[],{reviewConfirmed:true,reviewReason:'다른 파일 중복 및 원본 확인'});
 assert.equal(E.preview(sale,[o()],ledger).status,'ALREADY_LINKED');
});
test('다른 파일의 동일 내용은 자동 재반영하지 않음',()=>{
 const sale=s({documentNo:'',importBatchHash:'b'.repeat(64),sheetIndex:0,sourceRowIndex:4});
 const ledger=commit(sale,[o()],[],{reviewConfirmed:true,reviewReason:'검토'});
 const p=E.preview({...sale,importBatchHash:'c'.repeat(64)},[o({id:'2'})],ledger);
 assert.equal(p.status,'REVIEW');
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
