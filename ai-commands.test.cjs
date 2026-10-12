const {test}=require('node:test');
const assert=require('node:assert/strict');
const A=require('./ai-commands.js');

/* index.html의 기준정보 함수를 흉내 낸 최소 helpers — 규칙은 index.html과 같게(norm·itemKeys는 동일 구현) */
const norm=s=>String(s||'').toUpperCase().replace(/[\s\(\)\[\]\-_.,#\/㈜주식회사]/g,'');
const itemKeys=s=>[norm(s)];
const MATS=[{name:'P-1000',loc:'A-01',vendor:'한화',use:'경질'},{name:'TIONA-696(백)',loc:'B-02',vendor:'(확인 필요)',use:'DBP'},{name:'M-210',loc:'C-01',vendor:'',use:''}];
const helpers={
  norm,itemKeys,
  matchItem:q=>MATS.find(m=>norm(m.name)===norm(q)||norm(m.name).includes(norm(q)))||null,
  locOf:q=>{const m=MATS.find(m=>norm(m.name)===norm(q));return m?m.loc:'';},
  leadOf:()=>2,
  deptOf:m=>m.use==='경질'?'경질':m.use==='DBP'?'DBP':'전사',
  ropOf:q=>norm(q)==='P1000'?{vendor:'한화케미칼',lt:3}:null,
  addDays:(d,n)=>{const x=new Date(d+'T00:00:00');x.setDate(x.getDate()+n);return x.toISOString().slice(0,10);},
  isM210:it=>norm(it).includes('M210'),
};
const today='2026-10-12';
const mkS=()=>({seq:100,moves:[],notes:[],
  orders:[
    {id:1,type:'self',item:'P-1000',vendor:'한화',qty:2000,unit:'kg',eta:'2026-10-14',inDate:''},
    {id:2,type:'self',item:'P-1000',vendor:'한화',qty:5000,unit:'kg',eta:'2026-10-20',inDate:''},
    {id:3,type:'self',item:'P-1000',vendor:'한화',qty:1000,unit:'kg',eta:'2026-10-01',inDate:'2026-10-02'},
    {id:4,type:'self',item:'TIONA-696(백)',vendor:'',qty:10000,unit:'kg',eta:'2026-10-15',inDate:'',skip:true},
  ],
  cons:[
    {id:11,consignee:'(주)대양물산',item:'SP-390',qty:500,unit:'kg',due:'2026-10-15',action:'직접출고',ordDate:'',outDate:'',done:false},
    {id:12,consignee:'대양물산',item:'SP-390',qty:800,unit:'kg',due:'2026-10-18',action:'직접출고',ordDate:'',outDate:'',done:false},
    {id:13,consignee:'한솔',item:'M-210',qty:300,unit:'kg',due:'2026-10-20',action:'발주',ordDate:'',outDate:'',done:false},
    {id:14,consignee:'한솔',item:'SP-390',qty:100,unit:'kg',due:'2026-10-01',action:'직접출고',ordDate:'',outDate:'2026-10-02',done:true},
  ]});
const ctx=S=>({S,today,helpers});
/* index.html csApplyMark와 같은 규칙 */
function csApplyMark(c,f){if(f==='done'){c.done=true;if(c.action==='발주'&&!c.inDate)c.inDate=today;}else{c[f]=today;if(f==='outDate')c.done=true;}if(f==='outDate'||f==='done')c.outBy='자재과';}

test('buildContext: 열린 발주·사급 건만 id와 함께 보내고 닫힌 건·건너뜀 건은 빠짐',()=>{
  const c=A.buildContext({S:mkS(),materials:['P-1000','P-1000',' TIONA-696(백) '],consignees:['한솔'],vendors:['한화',''],today});
  assert.deepEqual(c.openOrders.map(o=>o.id),[1,2]);
  assert.deepEqual(c.openCons.map(o=>o.id),[11,12,13]);
  assert.deepEqual(c.items,['P-1000','TIONA-696(백)']);
  assert.ok(c.consignees.includes('(주)대양물산')&&c.consignees.includes('한솔'),'사급처 목록에 열린 건의 사급처도 포함');
  assert.deepEqual(c.vendors,['한화']);
  assert.equal(c.today,today);
});

test('normalizeOps: 모르는 type·빈 항목 제거, 날짜 형식 검증, 10건 상한',()=>{
  const ops=A.normalizeOps({ops:[{type:'add_note',text:'  메모  '},{type:'delete_all'},null,{type:'mark_in',id:'2',date:'10/20'},
    ...Array.from({length:12},()=>({type:'add_note',text:'x'}))]});
  assert.equal(ops.length,10);
  assert.equal(ops[0].text,'메모');
  assert.equal(ops[1].id,2,'id는 숫자로');
  assert.equal(ops[1].date,'','YYYY-MM-DD가 아니면 비움');
  assert.deepEqual(A.normalizeOps(null),[]);
});

test('add_move: 품목 표기 보정·출고창고 자동·부서 없으면 기준정보 부서, 수량 없으면 반영 불가',()=>{
  const S=mkS();
  const [p,q,r]=A.planOps([{type:'add_move',item:'p1000',qty:2000,unit:'KG',dept:'경질'},{type:'add_move',item:'P-1000',qty:500},{type:'add_move',item:'P-1000'}],ctx(S));
  assert.equal(p.ok,true);assert.equal(p.create.row.item,'P-1000');assert.equal(p.create.row.loc,'A-01');assert.equal(p.create.row.unit,'kg');assert.equal(p.create.row.date,today);
  assert.equal(q.ok,true);assert.equal(q.create.row.dept,'경질','부서를 안 적으면 기준정보 사용 부서');
  assert.equal(r.ok,false);assert.match(r.reason,/수량/);
});

test('add_move: 부서를 알 수 없는 품목은 반영 불가(사람이 적어야 함)',()=>{
  const [p]=A.planOps([{type:'add_move',item:'새품목XYZ',qty:10}],ctx(mkS()));
  assert.equal(p.ok,false);assert.match(p.reason,/부서/);
  const [q]=A.planOps([{type:'add_move',item:'새품목XYZ',qty:10,dept:'타일'}],ctx(mkS()));
  assert.equal(q.ok,true);assert.match(q.desc,/신규 품목/);
});

test('add_order: 매입처는 ROP → 기준정보 순, "(확인 필요)" 업체는 비움, 착일은 리드타임 자동',()=>{
  const S=mkS();
  const [p,q]=A.planOps([{type:'add_order',item:'P-1000',qty:3000},{type:'add_order',item:'TIONA-696 백',qty:10000,unit:'kg',date:'2026-10-30'}],ctx(S));
  assert.equal(p.ok,true);assert.equal(p.create.row.vendor,'한화케미칼');assert.equal(p.create.row.eta,'2026-10-14');assert.equal(p.create.row.type,'self');assert.equal(p.create.row.dest,'자가(세종·부강)');
  assert.equal(q.ok,true);assert.equal(q.create.row.vendor,'');assert.equal(q.create.row.eta,'2026-10-30');assert.equal(q.create.row.item,'TIONA-696(백)');
});

test('mark_in: id 지정이면 그 건, 품목만이면 열린 건 중 후보 — 2건이면 사람이 고를 때까지 반영 불가',()=>{
  const S=mkS();
  const [byId,byItem,byQty,closed]=A.planOps([
    {type:'mark_in',id:2},{type:'mark_in',item:'P-1000'},{type:'mark_in',item:'P-1000',qty:5000},{type:'mark_in',id:3}],ctx(S));
  assert.equal(byId.ok,true);assert.equal(byId.target,2);assert.deepEqual(byId.after,{inDate:today});
  assert.equal(byItem.ok,false);assert.equal(byItem.candidates.length,2);assert.match(byItem.reason,/2건/);
  assert.equal(byQty.ok,true);assert.equal(byQty.target,2,'수량이 맞는 1건으로 좁힘');
  assert.equal(closed.ok,false,'이미 입고된 건(id 3)은 id로 찍어도 열린 건이 아님');
  assert.equal(closed.candidates.length,0);
});

test('edit_order / edit_cons: 바꿀 값만 before→after, 없으면 반영 불가',()=>{
  const S=mkS();
  const [e1,e2,e3]=A.planOps([{type:'edit_order',id:1,date:'2026-10-16',qty:2500},{type:'edit_order',id:1},{type:'edit_cons',item:'SP-390',consignee:'한솔',date:'2026-10-25'}],ctx(S));
  assert.equal(e1.ok,true);assert.deepEqual(e1.before,{eta:'2026-10-14',qty:2000});assert.deepEqual(e1.after,{eta:'2026-10-16',qty:2500});
  assert.match(e1.desc,/착일 2026-10-14 → 2026-10-16/);
  assert.equal(e2.ok,false);assert.match(e2.reason,/바꿀 내용/);
  assert.equal(e3.ok,false,'한솔 SP-390은 완료된 건(id 14)뿐 → 열린 건 없음');
  const [e4]=A.planOps([{type:'edit_cons',item:'SP-390',consignee:'대양물산',date:'2026-10-25'}],ctx(S));
  assert.equal(e4.ok,false);assert.equal(e4.candidates.length,2,'대양물산 SP-390은 2건(㈜ 표기 차이 무시)');
});

test('mark_cons: 처리 종류 검증, M-210은 행선지 확인 없으면 차단, 이미 처리된 건은 차단',()=>{
  const S=mkS();
  const [ok,bad,m210,m210ord]=A.planOps([
    {type:'mark_cons',id:11,mark:'outDate'},{type:'mark_cons',id:11,mark:'ship'},{type:'mark_cons',id:13,mark:'done'},{type:'mark_cons',id:13,mark:'ordDate'}],ctx(S));
  assert.equal(ok.ok,true);assert.match(ok.desc,/출고 완료/);
  assert.equal(bad.ok,false);assert.match(bad.reason,/처리 종류/);
  assert.equal(m210.ok,false);assert.match(m210.reason,/M-210/);assert.equal(m210.candidates.length,0,'M-210 차단은 후보 선택으로 못 풀어야 함');
  assert.equal(m210ord.ok,true,'M-210도 공급사 발주 완료 표시는 행선지와 무관');
  S.cons[0].outDate='2026-10-11';
  const [dup]=A.planOps([{type:'mark_cons',id:11,mark:'outDate'}],ctx(S));
  assert.equal(dup.ok,false);assert.match(dup.reason,/이미 출고/);
});

test('applyPlan → undoChanges: 등록·수정·처리를 반영하고 그대로 되돌림(등록 건은 휴지통으로)',()=>{
  const S=mkS();
  const plan=A.planOps([
    {type:'add_move',item:'P-1000',qty:2000,dept:'경질'},
    {type:'add_note',text:'내일 점검'},
    {type:'mark_in',id:2},
    {type:'edit_cons',id:12,date:'2026-10-25'},
    {type:'mark_cons',id:11,mark:'outDate'},
    {type:'mark_in',item:'P-1000'},   // 후보 2건 → ok=false → 적용 제외
  ],ctx(S));
  assert.deepEqual(plan.map(p=>p.ok),[true,true,true,true,true,false]);
  const before=JSON.stringify({moves:S.moves,notes:S.notes,orders:S.orders,cons:S.cons});
  const {applied,changes}=A.applyPlan(plan,{S,today,who:'자재과',noteBy:'',csApplyMark});
  assert.equal(applied,5);
  assert.equal(S.moves.length,1);assert.equal(S.moves[0].id,100);assert.equal(S.seq,102);
  assert.equal(S.notes[0].by,'','메모 등록자는 addNote와 같이 이름 미입력이면 빈칸(처리자 기본값 자재과를 쓰지 않음)');
  assert.equal(S.orders[1].inDate,today);assert.equal(S.orders[1].inBy,'자재과');
  assert.equal(S.cons[1].due,'2026-10-25');
  assert.equal(S.cons[0].outDate,today);assert.equal(S.cons[0].done,true);
  const trashed=[];
  const n=A.undoChanges(changes,{S,toTrash:(k,rows)=>trashed.push([k,rows.length])});
  assert.equal(n,5);
  S.seq=100;   // seq는 되돌리지 않음(새 id 충돌 방지) — 비교를 위해 맞춤
  assert.equal(JSON.stringify({moves:S.moves,notes:S.notes,orders:S.orders,cons:S.cons}),before,'수정 칸은 원래 값으로, 없던 칸(inBy·outBy)은 다시 없어짐');
  assert.deepEqual(trashed.sort(),[['moves',1],['notes',1]],'등록 건은 메모까지 휴지통으로(delNote와 같게)');
});

test('대상 찾기: 정확 일치 우선, 부분 일치(P-1000 ↔ SP-1000)만 있으면 1건이어도 사람이 골라야 함',()=>{
  const S=mkS();
  S.orders.push({id:5,type:'self',item:'SP-1000',vendor:'한화',qty:700,unit:'kg',eta:'2026-10-19',inDate:''});
  const [exact]=A.planOps([{type:'mark_in',item:'P-1000',qty:2000}],ctx(S));
  assert.equal(exact.ok,true);assert.equal(exact.target,1,'SP-1000이 섞여 있어도 정확 일치 P-1000만 후보');
  S.orders=S.orders.filter(o=>o.item!=='P-1000');
  const [near]=A.planOps([{type:'mark_in',item:'P-1000'}],ctx(S));
  assert.equal(near.ok,false);assert.equal(near.candidates.length,1);assert.match(near.reason,/비슷한 건/);
  const [picked]=A.planOps([{type:'mark_in',item:'P-1000',id:5}],ctx(S));
  assert.equal(picked.ok,true,'사용자가 고르면(id) 반영 가능');
});

test('edit_order: vendor는 대상 찾는 조건일 뿐 매입처를 바꾸지 않음',()=>{
  const [p]=A.planOps([{type:'edit_order',id:1,vendor:'한화',date:'2026-10-20'}],ctx(mkS()));
  assert.equal(p.ok,true);assert.deepEqual(Object.keys(p.after),['eta']);
});

test('applyPlan: 미리보기 뒤 사라진 대상은 건너뛰고 반영 건수에서 빠짐',()=>{
  const S=mkS();
  const plan=A.planOps([{type:'mark_in',id:2}],ctx(S));
  S.orders=S.orders.filter(o=>o.id!==2);
  const {applied,changes}=A.applyPlan(plan,{S,today,who:'',csApplyMark});
  assert.equal(applied,0);assert.equal(changes.length,0);
});

/* ───── 규칙 기반 해석 ───── */
const PCTX={today:'2026-10-12',items:['P-1000','TIONA-696(백)','TIONA-696(지대)','SP-390','M-210','PMS-1803'],consignees:['(주)대양물산','한솔']};
const parse=t=>A.parseLocal(t,PCTX,{norm}).ops.map(o=>Object.fromEntries(Object.entries(o).filter(([k,v])=>v!=null)));

test('규칙 해석: 창고이동·발주 등록 — 톤은 kg로, 백/PLT 단위, 괄호 표기(백·지대) 품목 보정',()=>{
  assert.deepEqual(parse('경질 P-1000 2톤 이동'),[{type:'add_move',item:'P-1000',dept:'경질',qty:2000,unit:'kg'}]);
  assert.deepEqual(parse('타일 PMS-1803 5백 가져다 주세요'),[{type:'add_move',item:'PMS-1803',dept:'타일',qty:5,unit:'Bag'}]);
  assert.deepEqual(parse('DBP TIONA-696 지대 3PLT 이동'),[{type:'add_move',item:'TIONA-696(지대)',dept:'DBP',qty:3,unit:'PLT'}]);
  assert.deepEqual(parse('TIONA-696 백 10톤 발주'),[{type:'add_order',item:'TIONA-696(백)',qty:10000,unit:'kg'}]);
  assert.deepEqual(parse('P-1000 3000 발주 착일 10/20'),[{type:'add_order',item:'P-1000',qty:3000,date:'2026-10-20'}]);
});
test('규칙 해석: 입고·사급 처리 — 사급처 이름이나 "사급"이 있으면 사급 건, 업체는 조건으로',()=>{
  assert.deepEqual(parse('P-1000 발주 입고'),[{type:'mark_in',item:'P-1000'}]);
  assert.deepEqual(parse('P-1000 한화 입고 10/11'),[{type:'mark_in',item:'P-1000',vendor:'한화',date:'2026-10-11'}]);
  assert.deepEqual(parse('대양물산 SP-390 출고 완료'),[{type:'mark_cons',item:'SP-390',consignee:'(주)대양물산',mark:'outDate'}]);
  assert.deepEqual(parse('한솔 M-210 공급사 발주 완료'),[{type:'mark_cons',item:'M-210',consignee:'한솔',mark:'ordDate'}]);
  assert.deepEqual(parse('SP-390 사급 완료'),[{type:'mark_cons',item:'SP-390',mark:'done'}]);
  assert.deepEqual(parse('P-1000 완료'),[{type:'mark_in',item:'P-1000'}],'사급 표시가 없는 완료는 발주 입고');
});
test('규칙 해석: 수정 — 납기·착일·수량, "으로" 처리, 연도 추정',()=>{
  assert.deepEqual(parse('대양물산 SP-390 납기 10/20으로'),[{type:'edit_cons',item:'SP-390',consignee:'(주)대양물산',date:'2026-10-20'}]);
  assert.deepEqual(parse('P-1000 발주 착일 10/20으로'),[{type:'edit_order',item:'P-1000',date:'2026-10-20'}]);
  assert.deepEqual(parse('P-1000 수량 500으로'),[{type:'edit_order',item:'P-1000',qty:500}]);
  assert.deepEqual(parse('한솔 M-210 요청납기 1월 5일'),[{type:'edit_cons',item:'M-210',consignee:'한솔',date:'2027-01-05'}],'반년 넘게 과거인 날짜는 내년');
  assert.equal(A.parseDate('내일',PCTX.today).date,'2026-10-13');
  assert.equal(A.parseDate('2026-10-20 착일',PCTX.today).date,'2026-10-20');
  assert.equal(A.parseDate('13/45',PCTX.today),null);
});
test('규칙 해석: 메모·여러 줄·실패 안내',()=>{
  assert.deepEqual(parse('메모: 내일 오전 지게차 점검'),[{type:'add_note',text:'내일 오전 지게차 점검'}]);
  const r=A.parseLocal('경질 P-1000 2톤 이동\n아무말 대잔치 ; 메모 점검',PCTX,{norm});
  assert.equal(r.ops.length,2);assert.deepEqual(r.unparsed,['아무말 대잔치']);assert.match(r.message,/알아듣지 못한 줄/);
  const none=A.parseLocal('안녕',PCTX,{norm});
  assert.equal(none.ops.length,0);assert.match(none.message,/어순을 알아듣지 못했습니다/);
  assert.match(A.parseLocal('',PCTX,{norm}).message,/입력하세요/);
});
test('규칙 해석 결과는 planOps에 그대로 들어감(끝까지 연결)',()=>{
  const S=mkS();
  const ops=A.parseLocal('대양물산 SP-390 500 출고 완료\n경질 P-1000 2톤 이동',PCTX,{norm}).ops;
  const plan=A.planOps(ops,ctx(S));
  assert.deepEqual(plan.map(p=>[p.op.type,p.ok,p.target]),[['mark_cons',true,11],['add_move',true,null]],'수량 500으로 대양물산 2건 중 1건으로 좁힘');
});

test('규칙 해석: 소수점 톤은 날짜가 아니라 수량, 납기는 사급·착일은 발주로 구분',()=>{
  assert.deepEqual(parse('P-1000 1.5톤 발주'),[{type:'add_order',item:'P-1000',qty:1500,unit:'kg'}]);
  assert.deepEqual(parse('경질 P-1000 2.5톤 이동'),[{type:'add_move',item:'P-1000',dept:'경질',qty:2500,unit:'kg'}]);
  assert.deepEqual(parse('SP-390 납기 10/20'),[{type:'edit_cons',item:'SP-390',date:'2026-10-20'}],'사급처 없이도 납기는 사급 건');
  assert.deepEqual(parse('P-1000 착일 10/20'),[{type:'edit_order',item:'P-1000',date:'2026-10-20'}]);
  assert.deepEqual(parse('P-1000 2026.10.20 입고'),[{type:'mark_in',item:'P-1000',date:'2026-10-20'}]);
});
test('대상 찾기: 적은 업체·수량이 안 맞는 건을 대신 고르지 않음',()=>{
  const S=mkS();
  const [wrongVendor,wrongQty]=A.planOps([{type:'mark_in',item:'P-1000',vendor:'LG화학'},{type:'mark_in',id:null,item:'P-1000',qty:9999}],ctx(S));
  assert.equal(wrongVendor.ok,false);assert.match(wrongVendor.reason,/찾지 못함/);assert.equal(wrongVendor.candidates.length,0);
  assert.equal(wrongQty.ok,false);assert.equal(wrongQty.candidates.length,2,'수량이 안 맞으면 후보는 보여주되 사람이 고름');
});
test('normalizeOps: 범위를 벗어난 날짜는 버림',()=>{
  const [a,b]=A.normalizeOps([{type:'edit_order',id:1,date:'2026-13-45'},{type:'edit_order',id:1,date:'2026-02-29'}]);
  assert.equal(a.date,'');assert.equal(b.date,'','2026년은 평년');
  assert.equal(A.normalizeOps([{type:'edit_order',id:1,date:'2028-02-29'}])[0].date,'2028-02-29');
});
