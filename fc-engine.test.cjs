const {test}=require('node:test');
const assert=require('node:assert/strict');
const E=require('./fc-engine.js');

const near=(a,b,tol,msg)=>assert.ok(Math.abs(a-b)<=tol,`${msg||''} expected ${b}±${tol}, got ${a}`);

/* ── 소비량 시계열 ── */
test('소비량 시계열: 스냅샷 사이 소비를 날짜별로 균등 분배하고 입고분을 더함',()=>{
  const snaps=[{d:'2026-09-01',stock:{A:1000}},{d:'2026-09-03',stock:{A:800}},{d:'2026-09-04',stock:{A:1700}}];
  const inb=[{d:'2026-09-04',kg:1000}];   // 9/3→9/4 사이 1,000 입고 → 소비 = 800-1700+1000 = 100
  const s=E.consumptionSeries(snaps,inb,'A');
  assert.equal(s.points,3);
  assert.deepEqual(s.days.map(x=>x.d),['2026-09-02','2026-09-03','2026-09-04']);
  assert.deepEqual(s.days.map(x=>x.v),[100,100,100]);
  assert.equal(s.inKg,1000);assert.equal(s.anomalies,0);assert.equal(s.lastStock,1700);
  assert.equal(s.from,'2026-09-01');assert.equal(s.to,'2026-09-04');
  near(s.coverage,3/4,1e-9,'4일 중 3일 스냅샷');
});
test('소비량 시계열: 입고일과 재고 파일 시점이 어긋나도 입고분이 소비로 과대 계상되지 않음',()=>{
  // 입고 1,000을 9/3로 기록했지만 재고 파일에는 9/4에야 반영된 경우 — 실제 소비는 400
  const snaps=[1000,900,800,1700,1600].map((v,i)=>({d:'2026-09-0'+(i+1),stock:{A:v}}));
  const s=E.consumptionSeries(snaps,[{d:'2026-09-03',kg:1000}],'A');
  assert.deepEqual(s.days.map(x=>x.v),[100,200,0,100]);
  assert.equal(s.anomalies,0);assert.equal(s.inKg,1000);   // 표시용 입고 총량은 기록 그대로
  // 반대로 재고 파일에 먼저 잡히고 입고일이 뒤에 찍힌 경우도 같음
  const s2=E.consumptionSeries(snaps,[{d:'2026-09-05',kg:1000}],'A');
  assert.equal(s2.days.reduce((a,x)=>a+x.v,0),400);
  assert.equal(s2.anomalies,0);
});
test('소비량 시계열: 입고 기록 없이 재고가 늘면 소비 0으로 보고 이상 건수로 셈',()=>{
  const snaps=[{d:'2026-09-01',stock:{A:100}},{d:'2026-09-02',stock:{A:300}}];
  const s=E.consumptionSeries(snaps,[],'A');
  assert.deepEqual(s.days,[{d:'2026-09-02',v:0}]);
  assert.equal(s.anomalies,1);
});
test('소비량 시계열: 같은 날 중복은 뒤 것 우선, 품목 없는 스냅샷·이상 값은 건너뜀',()=>{
  const snaps=[{d:'2026-09-01',stock:{A:500}},{d:'2026-09-01',stock:{A:400}},{d:'2026-09-02',stock:{B:1}},{d:'2026-09-03',stock:{A:'x'}},{d:'2026-09-04',stock:{A:'100'}},null];
  const s=E.consumptionSeries(snaps,null,'A');
  assert.equal(s.points,2);
  assert.deepEqual(s.days.map(x=>x.v),[100,100,100]);   // 400→100을 3일에 나눔
});
test('소비량 시계열: 스냅샷 1개 이하면 빈 결과',()=>{
  assert.deepEqual(E.consumptionSeries([{d:'2026-09-01',stock:{A:1}}],[],'A').days,[]);
  assert.equal(E.consumptionSeries([],[],'A').points,0);
  assert.equal(E.consumptionSeries(null,null,'A').coverage,0);
});

/* ── 모델 적합 ── */
test('모델: 일정한 소비는 그 값 그대로 예측하고 σ는 0',()=>{
  const f=E.fit(Array(30).fill(50));
  assert.ok(f);near(f.rate,50,1e-9);near(f.sigma,0,1e-9);
  assert.equal(f.n,30);assert.equal(f.validated,7);near(f.accuracy,1,1e-9);
});
test('모델: 뚜렷한 증가 추세가 있으면 추세 모델을 고르고 미래 소비를 더 높게 봄',()=>{
  const y=Array.from({length:40},(_,i)=>100+i*5);
  const f=E.fit(y);
  assert.equal(f.kind,'holt');
  assert.ok(f.rateFor(10)>y[y.length-1],'마지막 실적보다 높은 예측');
});
test('모델: 표본이 3개 미만이면 null, {d,v} 객체 배열도 받음',()=>{
  assert.equal(E.fit([1,2]),null);
  assert.equal(E.fit(null),null);
  const f=E.fit([{d:'a',v:10},{d:'b',v:10},{d:'c',v:10}]);
  assert.ok(f);near(f.rate,10,1e-9);assert.equal(f.validated,0);assert.equal(f.accuracy,null);
});
test('모델: 음수·이상 값은 버리고 예측 경로는 0 미만으로 내려가지 않음',()=>{
  const y=Array.from({length:30},(_,i)=>Math.max(0,100-i*10));   // 빠르게 줄어 0으로
  const f=E.fit(y.concat([-5,'x']));
  assert.equal(f.n,30);
  const m={kind:'holt',level:5,trend:-10,phi:0.9};
  assert.ok(E.path(m,20).every(v=>v>=0));
});
test('모델: 검증 정확도는 1-WAPE, 실적 합이 0이면 null',()=>{
  const f=E.fit(Array(20).fill(0));
  assert.ok(f);assert.equal(f.accuracy,null);near(f.rate,0,1e-9);
});

/* ── 재고 판단 ── */
test('안전재고 = z·σ·√(LT+검토주기), 리드타임 0이라도 최소 1일',()=>{
  near(E.safetyStock(10,4,5,2),2*10*3,1e-9);
  near(E.safetyStock(10,0,0,1.65),16.5,1e-9);
  assert.equal(E.safetyStock(null,3,7,1.65),0);
});
test('동적 발주점 = 일 소비×리드타임 + 안전재고',()=>{
  near(E.dynamicRop(100,3,50),350,1e-9);
  assert.equal(E.dynamicRop(null,3,null),0);
});
test('소진 예상: 변동이 없으면 범위가 한 점, 변동이 있으면 낙관≤기대≤비관',()=>{
  const d0=E.depletion(1000,100,0,1.65);
  near(d0.days,10,1e-9);near(d0.lo,10,1e-9);near(d0.hi,10,1e-9);
  const d=E.depletion(1000,100,30,1.65);
  assert.ok(d.lo<d.days&&d.days<d.hi);
  // 경계 검산: rate·lo + zσ√lo = stock
  near(100*d.lo+1.65*30*Math.sqrt(d.lo),1000,1e-6);
  near(100*d.hi-1.65*30*Math.sqrt(d.hi),1000,1e-6);
  assert.equal(E.depletion(1000,0,10),null);
  assert.deepEqual(E.depletion(0,100,10),{days:0,lo:0,hi:0});
});
test('리스크: 입고예정 포함 가용량으로 부족·발주 필요를 가르고, 과잉은 현재고로만 판단',()=>{
  assert.equal(E.risk({rate:0,stock:100}),'none');
  assert.equal(E.risk({rate:100,stock:200,lt:3,review:7}),'short');          // 2일치 ≤ LT 3
  assert.equal(E.risk({rate:100,stock:200,onOrder:200,lt:3,review:7}),'order'); // 4일치 ≤ LT+검토 10
  assert.equal(E.risk({rate:100,stock:200,onOrder:1000,lt:3,review:7}),'ok');   // 12일치
  assert.equal(E.risk({rate:10,stock:1000,lt:3,review:7}),'excess');            // 100일치 ≥ 90
  assert.equal(E.risk({rate:10,stock:1000,lt:3,review:7,overDays:120}),'ok');
});
test('리스크: 안전재고까지 넣어 판단 — 권장 발주량이 0보다 큰 것과 같은 조건',()=>{
  const p={rate:100,stock:1100,lt:3,review:7,ss:200};   // 목표 1,200 > 가용 1,100
  assert.equal(E.risk(p),'order');
  assert.equal(E.suggestQty(p),100);
  const q={rate:100,stock:1300,lt:3,review:7,ss:200};
  assert.equal(E.risk(q),'ok');
  assert.equal(E.suggestQty(q),0);
});
test('권장 발주량: 목표(LT+검토 소비+안전재고) − 현재고 − 입고예정, 최소량·로트 반영',()=>{
  assert.equal(E.suggestQty({rate:100,lt:3,review:7,ss:200,stock:300,onOrder:100}),800);   // 1200-300-100
  assert.equal(E.suggestQty({rate:100,lt:3,review:7,ss:200,stock:300,onOrder:100,minQty:1000}),1000);
  assert.equal(E.suggestQty({rate:100,lt:3,review:7,ss:200,stock:300,onOrder:100,lot:500}),1000);
  assert.equal(E.suggestQty({rate:100,lt:3,review:7,ss:0,stock:5000}),0);
  assert.equal(E.suggestQty({rate:0,stock:0}),0);
});

/* ── 종합 ── */
test('종합 판단: 일정 소비 품목의 커버일수·동적 발주점·권장량이 손계산과 맞음',()=>{
  const a=E.assess({series:Array(30).fill(100),stock:500,onOrder:0,lt:2,review:7,z:1.65,minQty:0});
  assert.ok(a.ok);
  near(a.rate,100,1e-9);near(a.cover,5,1e-9);near(a.dynRop,200,1e-9);   // σ=0 → 안전재고 0
  assert.equal(a.risk,'order');                                           // 5일치 ≤ 2+7
  assert.equal(a.suggestQty,400);                                         // 900-500
  near(a.depletion.days,5,1e-9);
});
test('종합 판단: 표본 부족이면 ok=false, 재고 없으면 커버·리스크 판단 불가',()=>{
  const a=E.assess({series:[1,2],stock:100});
  assert.equal(a.ok,false);assert.equal(a.reason,'표본 부족');
  const b=E.assess({series:Array(10).fill(5),stock:null});
  assert.ok(b.ok);assert.equal(b.cover,null);assert.equal(b.risk,'none');assert.equal(b.suggestQty,0);
});
test('리스크 라벨·정렬·서비스 수준 표가 있음',()=>{
  assert.equal(E.RISK_LABEL.short,'부족 위험');
  assert.ok(E.RISK_ORDER.short<E.RISK_ORDER.order&&E.RISK_ORDER.order<E.RISK_ORDER.excess);
  assert.equal(E.Z_BY_SERVICE[95],1.65);
});
