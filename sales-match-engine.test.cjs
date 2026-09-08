const {test}=require('node:test');
const assert=require('node:assert/strict');
const E=require('./sales-match-engine.js');
const aliases=require('./alias-candidates.json');
const s=(x={})=>({sourceSystem:'TEST',issuerId:'TEST',documentNo:'1',documentLine:'1',vendor:'동부엔지니어링',item:'IF850',qty:1000,unit:'kg',date:'2026-09-07',...x});
const o=(x={})=>({id:'1',action:'발주',vendor:'동부엔지니어링',item:'IF-850',qty:1000,unit:'kg',orderDate:'2026-09-01',requestDate:'2026-08-31',done:false,...x});
function commit(sale,orders,ledger=[],extra={}) {
 const p=E.preview(sale,orders,ledger,aliases);
 return E.commit({sale,orders,ledger,aliases,allocations:p.proposal,actor:'테스트',now:'2026-09-08T00:00:00Z',eventId:'e1',
 expectedOrders:Object.fromEntries(orders.map(x=>[x.id,E.orderSnapshot(x)])),expectedSourceSnapshot:E.sourceSnapshot(sale),...extra});
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
test('직접출고 완료 건도 후보이며 미리보기가 원본을 변경하지 않음',()=>{
 const orders=[o({action:'직접출고',done:true,outDate:'2026-09-02',item:'P-560J 14동 1열',qty:200})];
 const original=JSON.stringify(orders);
 const p=E.preview(s({item:'경질_가공조제_P-560J_P/B(25kg)',qty:200}),orders);
 assert.equal(p.candidates.length,1);assert.equal(p.status,'REVIEW');assert.equal(JSON.stringify(orders),original);
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
test('완료 이력 후보 연결은 검토 필수, 기존 완료일은 보존',()=>{
 const orders=[o({done:true,inDate:'2026-09-02'})];
 assert.throws(()=>commit(s(),orders),/검토/);
 commit(s(),orders,[],{reviewConfirmed:true,reviewReason:'전표와 발주 대조 완료'});
 assert.equal(orders[0].inDate,'2026-09-02');
});
test('M210 행선지는 검토 버튼만으로 우회 불가',()=>{
 const sale=s({item:'M210'}),orders=[o({item:'M-210'})];
 assert.throws(()=>commit(sale,orders,[],{reviewConfirmed:true,reviewReason:'확인'}),/행선지/);
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
