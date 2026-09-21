/* Reference integration module. No DOM, network, S mutation or automatic approval. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CsSalesEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = 1;
  const compact = v => String(v ?? '').normalize('NFKC').toUpperCase().replace(/[\s_\-.,#()[\]/]/g, '');
  function regNo(v) {
    const m = String(v ?? '').match(/(?:^|[^0-9])(\d{3}-?\d{2}-?\d{5})(?!\d)/);
    return m ? m[1].replace(/-/g, '') : '';
  }
  function vendorName(v) {
    return compact(String(v ?? '').normalize('NFKC')
      .replace(/\(\s*\d{3}-?\d{2}-?\d{5}\s*\)/g, '')
      .replace(/주식회사|유한회사|㈜|\(\s*주\s*\)|\(\s*유\s*\)/g, ''));
  }
  function cleanItem(v) {
    return String(v ?? '').normalize('NFKC')
      .replace(/\b\d+동(?:\s*\d+열)?/g, ' ')
      .replace(/\b[MP]창고\b/gi, ' ')
      .replace(/[MP]창고/gi, ' ')
      .replace(/미등록|\bSILO\b/gi, ' ').trim();
  }
  // Unit table. NFKC folds Excel-style compatibility characters (㎏ → kg, ℓ → l, ㎖ → ml) before lookup.
  // PACK units (포·BOX·롤·드럼…) carry no fixed factor: amount() converts them to MASS only when the
  // caller supplies the item's per-pack kg (opts.packKgOf); otherwise they stay family PACK and are
  // hard-blocked until the master data is filled in.
  const UNIT_TABLE = [
    [['KG','KGS','KG.','K/G','킬로그램','킬로'], 'MASS', 1],
    [['T','TON','TONNE','MT','톤'], 'MASS', 1000],
    [['G','GR','그램'], 'MASS', 0.001],
    [['M','미터'], 'LENGTH', 1],
    [['MM'], 'LENGTH', 0.001],
    [['L','LT','LTR','리터'], 'VOLUME', 1],
    [['ML','밀리리터'], 'VOLUME', 0.001],
    [['EA','PCS','PC','개','매','장','본','SET','세트'], 'COUNT', 1],
    [['포','포대','BAG','백','BOX','박스','롤','ROLL','드럼','DRUM','CAN','캔','통','PLT','파렛트','팔레트','PALLET'], 'PACK', null],
  ];
  function unit(v) {
    const u = String(v ?? '').normalize('NFKC').replace(/\s+/g, '').toUpperCase();
    for (const [names, family, factor] of UNIT_TABLE) if (names.includes(u)) return {family, factor};
    return null;
  }
  // Families that may be compared after conversion. MASS↔VOLUME is the one cross-family pair the
  // operator may reconcile by hand (kg↔L without a density on file): such candidates stay listed
  // with an issue, are never auto-proposed, and a commit must state the sale-side quantity consumed.
  const crossFamilyOk = (a, b) => a && b && a !== b && ['MASS','VOLUME'].includes(a) && ['MASS','VOLUME'].includes(b);
  function amount(q, u, packKg) {
    const s = String(q ?? '').trim().replace(/,/g, '');
    if (!/^(?:\d+)(?:\.\d+)?$/.test(s) || !(Number(s)>0)) return null;
    const info = unit(u), n = Number(s);
    if (!info) return {value:n, family:null};
    if (info.family === 'PACK') {
      const k = Number(packKg);
      return Number.isFinite(k) && k > 0 ? {value:n*k, family:'MASS', packKg:k} : {value:n, family:'PACK'};
    }
    return {value:n*info.factor, family:info.family};
  }
  // kg (or L, m, EA) per one raw unit — null when the unit cannot be converted.
  function baseFactor(u, packKg) {
    const a = amount(1, u, packKg);
    return a && a.family && a.family !== 'PACK' ? a.value : null;
  }
  const unitLabel = v => String(v ?? '').normalize('NFKC').trim();
  // Hard-block text for a unit the ledger cannot compare: unknown (empty or unrecognised) or a pack
  // unit with no per-pack kg on file. Returns '' when the unit is usable.
  function unitProblem(side, rawUnit, family) {
    if (family === 'PACK') return `${side} 포장 단위(${unitLabel(rawUnit)}) 환산 정보 필요 — 기준정보에 품목 포장 kg 입력`;
    if (!family) return `${side} 단위 확인 필요` + (unitLabel(rawUnit) ? `(미인식 "${unitLabel(rawUnit)}")` : '');
    return '';
  }
  function isoDate(v) {
    const s = String(v || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
    const d = new Date(s+'T00:00:00Z');
    return Number.isFinite(+d) && d.toISOString().slice(0,10)===s ? s : '';
  }
  // Boundary checks preserve grade suffixes: IF850 != IF850B; 293F1 != 293F10.
  function itemForms(v) {
    const text = cleanItem(v);
    return [...new Set([compact(text), ...text.split(/[_()\[\]/]+/).map(compact)])]
      .filter(x => /[A-Z]/.test(x) && /\d/.test(x) && x.length>=3 && x!=='TIO2'
        && !/^\d+(?:KG|G|L|ML|EA|PCS|M|TON|MT)$/.test(x));
  }
  function hasBounded(haystack, needle) {
    if (!needle || needle.length < 3) return false;
    const h = cleanItem(haystack).toUpperCase();
    // Search independently delimited description segments, preserving spaces as
    // possible model separators (SONGSORB CS 928 -> SONGSORBCS928).
    const segments = h.split(/[_()\[\]/]+/).map(compact);
    return segments.some(s => s === needle);
  }
  const emptyAliases = () => ({vendors:[], items:[]});
  function vendorMatch(s, o, aliases) {
    const a = regNo(s.vendorRegNo || s.vendor), b = regNo(o.vendorRegNo || o.vendor);
    if (a && b) return a===b ? {level:'exact', reason:'사업자번호 일치'} : {level:'blocked', reason:'사업자번호 충돌'};
    const x=vendorName(s.vendor), y=vendorName(o.vendor);
    if (!x || !y) return {level:'none', reason:'업체명 누락'};
    if (x===y) return {level:'exact', reason:'업체 표기 일치'};
    for (const g of aliases.vendors || []) {
      const names=(g.names||[]).map(vendorName);
      if (names.includes(x)&&names.includes(y)) {
        if (g.regNo && ((a&&a!==g.regNo)||(b&&b!==g.regNo))) return {level:'blocked',reason:'별칭 사업자번호 충돌'};
        return {level:g.approved?'alias':'suggested', reason:g.approved?'승인된 업체 별칭':'업체 별칭 최초 확인 필요'};
      }
    }
    return {level:'none',reason:'업체 연결 없음'};
  }
  function itemMatch(s, o, aliases) {
    // ERP codes must be comparable codes, never compare one ERP code to a model name.
    if (s.itemCode && o.itemCode) return compact(s.itemCode)===compact(o.itemCode)
      ? {level:'exact',reason:'품목코드 일치'} : {level:'blocked',reason:'품목코드 충돌'};
    const x=compact(cleanItem(s.item)), y=compact(cleanItem(o.item));
    if (x&&x===y) return {level:'exact',reason:'품목 표기 일치'};
    const sf=itemForms(s.item), of=itemForms(o.item);
    if (sf.some(t=>hasBounded(o.item,t)) || of.some(t=>hasBounded(s.item,t)))
      return {level:'exact',reason:'구분된 제품 모델 일치'};
    for (const g of aliases.items || []) {
      if (g.vendor && ![s.vendor,o.vendor].some(v=>vendorName(v)===vendorName(g.vendor))) continue;
      const names=(g.names||[]).map(compact);
      if (names.some(n=>n===x||hasBounded(s.item,n)) && names.some(n=>n===y||hasBounded(o.item,n)))
        return {level:g.approved?'alias':'suggested',reason:g.approved?'승인된 품목 별칭':'품목 별칭 최초 확인 필요'};
    }
    return {level:'none',reason:'품목 연결 없음'};
  }
  // Real transaction line preferred; file-byte SHA256 fallback is review-only.
  function sourceKey(s) {
    if (s.sourceSystem && s.issuerId && s.documentNo && s.documentLine)
      return JSON.stringify(['transaction',s.sourceSystem,s.issuerId,s.documentNo,s.documentLine].map(String));
    if (/^[a-f0-9]{64}$/i.test(s.importBatchHash||'') && Number.isInteger(s.sheetIndex) && s.sheetIndex>=0 && Number.isInteger(s.sourceRowIndex) && s.sourceRowIndex>=0)
      return JSON.stringify(['file-row',s.importBatchHash.toLowerCase(),s.sheetIndex,s.sourceRowIndex]);
    return null;
  }
  // packKg (pack→kg factor actually used) is part of the snapshot only when a conversion applied, so
  // a later master-data edit is detected as a change instead of silently moving remaining quantities.
  // Records without a conversion keep the original shape, so ledgers written before this existed match.
  const withPack = (fields, packKg) => JSON.stringify(packKg ? [...fields, packKg] : fields);
  function sourceSnapshot(s, packKg) {
    return withPack([s.vendor,s.vendorRegNo||'',s.item,s.itemCode||'',s.qty,s.unit||'',s.date||'',s.destination||''], packKg);
  }
  function orderSnapshot(o, packKg) {
    return withPack([o.id,o.action,o.vendor,o.vendorRegNo||'',o.item,o.itemCode||'',o.qty,o.unit||'',o.requestDate||'',o.orderDate||'',o.done,o.outDate||'',o.inDate||'',o.destination||'',o.m210Confirmed||false], packKg);
  }
  // Date an order became a valid counterpart: order date (fallback request date) for 발주, request date for 직접출고.
  const orderStart = o => isoDate(o.action==='발주'?o.orderDate||o.requestDate:o.requestDate);
  const doneDate = o => isoDate(o.action==='발주'?(o.inDate||o.outDate):(o.outDate||o.inDate));
  // A completed order this much older than the sale was most likely sold before this ledger
  // existed (its remaining quantity is a phantom) — flagged so automatic allocation can skip it.
  const STALE_DONE_DAYS = 60;
  const daysBetween = (a,b) => Math.round((new Date(b+'T00:00:00Z')-new Date(a+'T00:00:00Z'))/86400000);
  const active = ledger => (ledger || []).filter(x=>!x.reversedAt);
  function usedForOrder(ledger, id) {
    return active(ledger).reduce((sum,e)=>sum+e.allocations.filter(a=>String(a.orderId)===String(id)).reduce((n,a)=>n+a.baseQty,0),0);
  }
  // Sale-side consumption of an allocation on the sale's base scale: saleBaseQty (recorded for kg↔L
  // allocations, converted from the operator's saleQty at commit time) else baseQty.
  const saleUsed = a => a.saleBaseQty != null ? +a.saleBaseQty : a.baseQty;
  function remainingOrder(o, ledger, packKg) {
    const q=amount(o.qty,o.unit,packKg);
    if (!q) return 0;
    // An unconverted pack count is not on the ledger's kg scale, so nothing can be subtracted from it.
    return q.family==='PACK' ? q.value : Math.max(0,q.value-usedForOrder(ledger,o.id));
  }
  // opts.packKgOf(item, unit) → kg per pack from the caller's master data. Consulted only for PACK
  // units and memoised per item|unit for the life of one preview/commit (the caller's lookup may be
  // a scan of its whole master list).
  function packKgResolver(opts) {
    const f = typeof opts?.packKgOf === 'function' ? opts.packKgOf : null, memo = new Map();
    return (item, u) => {
      if (!f || unit(u)?.family !== 'PACK') return null;
      const key = String(item ?? '') + '|' + String(u ?? '');
      if (!memo.has(key)) { let k = null; try { k = +f(item, u); } catch (_) { k = null; } memo.set(key, Number.isFinite(k) && k > 0 ? k : null); }
      return memo.get(key);
    };
  }
  function uniqueSubset(candidates, target) {
    if (candidates.length>12) return {kind:'too_many', sets:[]};
    const sets=[];
    function visit(i, sum, picked) {
      if (sets.length>1) return;
      if (Math.abs(sum-target)<1e-6 && picked.length) {sets.push(picked);return;}
      if (i===candidates.length || sum>target+1e-6) return;
      visit(i+1,sum,picked);
      visit(i+1,sum+candidates[i].remaining,[...picked,candidates[i].orderId]);
    }
    visit(0,0,[]);
    return {kind:sets.length===1?'unique':sets.length>1?'ambiguous':'none',sets};
  }
  // opts.manualOrderIds: orders the operator explicitly designated for this sale. They skip the
  // vendor/item gate (a human already decided they correspond) but still go through quantity,
  // unit and remaining checks, and always carry a '담당자 직접 지정' issue so commit() requires a
  // review reason. A regNo/itemCode conflict is a hard fact and is never overridden.
  // Returns rejected[] for orders that passed (or bypassed) the vendor/item gate but were still
  // excluded, so the UI can say why an expected order is not a candidate.
  // opts.packKgOf(item, unit): per-pack kg for PACK units (포·BOX·롤…), from the caller's master data.
  // Result fields added for units: salePackKg (conversion applied to the sale, else null), unitOk (sale
  // unit usable for commit); per candidate packKg, unitOk, crossFamily.
  function preview(sale, orders, ledger=[], aliases=emptyAliases(), opts={}) {
    const manualIds=new Set((opts.manualOrderIds||[]).map(String));
    const packKg=packKgResolver(opts), salePack=packKg(sale.item,sale.unit);
    const qty=amount(sale.qty,sale.unit,salePack), key=sourceKey(sale);
    // hardBlocked (row-level and per candidate): conditions commit() rejects regardless of review
    // confirmation — the data must be corrected, so the UI must not auto-select these.
    const base={sourceKey:key,sourceSnapshot:sourceSnapshot(sale,salePack),salePackKg:salePack,unitOk:false,candidates:[],proposal:[],issues:[],rejected:[],hardBlocked:[]};
    if (!qty) return {...base,status:'INVALID',issues:['수량은 양수여야 함; 반품/취소는 별도 정정 흐름 필요']};
    const prior=key?active(ledger).filter(e=>e.sourceKey===key):[];
    if (prior.some(e=>e.sourceSnapshot!==base.sourceSnapshot)) return {...base,status:'SOURCE_CHANGED',issues:['같은 전표행의 내용 변경; 기존 배분 정정 필요']};
    const allocated=prior.reduce((sum,e)=>sum+e.allocations.reduce((n,a)=>n+saleUsed(a),0),0);
    const remaining=qty.value-allocated;
    if (remaining < -1e-6) return {...base,status:'SOURCE_CHANGED',issues:['매각수량보다 기존 배분이 큼']};
    if (Math.abs(remaining)<1e-6) return {...base,status:'ALREADY_LINKED',remaining:0};
    if (!key) base.issues.push('전표번호·전표행번호 누락: 거래 중복 여부 확인 필요');
    if (key && JSON.parse(key)[0]==='file-row') base.issues.push('파일행 식별만 가능: 다른 파일의 기존 반영과 중복 여부 검토 필요');
    if (!isoDate(sale.date)) { base.issues.push('매각일 누락 또는 오류'); base.hardBlocked.push('매각일 누락 또는 오류'); }
    const saleUnitProblem=unitProblem('매각',sale.unit,qty.family);
    if (saleUnitProblem) { base.issues.push(saleUnitProblem); base.hardBlocked.push(saleUnitProblem); }
    const saleComparable=Boolean(qty.family && qty.family!=='PACK');
    base.unitOk=saleComparable;
    for (const o of orders) {
      if (!['발주','직접출고'].includes(o.action)) continue;
      const manual=manualIds.has(String(o.id));
      const reject=reason=>base.rejected.push({orderId:o.id,reason});
      const vm=vendorMatch(sale,o,aliases), im=itemMatch(sale,o,aliases);
      if (vm.level==='blocked'||im.level==='blocked') { if (manual) reject(vm.level==='blocked'?vm.reason:im.reason); continue; }
      if (!manual && (vm.level==='none'||im.level==='none')) continue;
      const oPack=packKg(o.item,o.unit), oq=amount(o.qty,o.unit,oPack), remainingQty=remainingOrder(o,ledger,oPack);
      if (!oq) { reject('발주/출고 수량 오류'); continue; }
      const orderComparable=Boolean(oq.family && oq.family!=='PACK');
      // A remaining quantity only means something on a comparable scale; otherwise the unit hard-block below explains.
      if (orderComparable && remainingQty<=1e-6) { reject('잔량 없음(이미 전부 배분됨)'); continue; }
      const issues=[], hardBlocked=[];
      const crossFamily=Boolean(saleComparable && orderComparable && crossFamilyOk(qty.family,oq.family));
      if (saleComparable && orderComparable && qty.family!==oq.family && !crossFamily) { reject('단위 종류 불일치(중량/길이/개수)'); continue; }
      if (crossFamily) issues.push(`단위 계열 다름(${qty.family==='MASS'?'kg':'L'}↔${oq.family==='MASS'?'kg':'L'}) — 매각·사급 수량 직접 확인`);
      if (!saleComparable||!orderComparable) issues.push('단위 확인 필요');
      const orderUnitProblem=unitProblem('발주/출고',o.unit,oq.family);
      if (orderUnitProblem) hardBlocked.push(!oq.family && !unitLabel(o.unit) ? '단위 확인 필요' : orderUnitProblem);   // 빈 단위는 종전 문구 유지(화면·테스트가 참조)
      const start=orderStart(o);
      if (!start) { issues.push('발주/접수일 확인 필요'); hardBlocked.push('발주/접수일 확인 필요'); }
      if (start && isoDate(sale.date) && sale.date<start) {
        if (!manual) { reject('매각일이 발주/접수일보다 앞섬'); continue; }
        issues.push('매각일이 발주/접수일보다 앞섬');
      }
      if (sale.destination && o.destination && sale.destination!==o.destination) { reject('행선지 불일치'); continue; }
      if (/(?:^|[^A-Z0-9])M[- ]?210(?:$|[^A-Z0-9])/i.test(sale.item+' '+o.item) &&
          (!o.m210Confirmed || !o.destination || !sale.destination)) { issues.push('M-210 행선지 확인 필요'); hardBlocked.push('M-210 행선지 확인 필요'); }
      if (vm.level==='suggested'||im.level==='suggested') issues.push('별칭 최초 확인 필요');
      if (manual) issues.push('담당자 직접 지정');
      // A completed (received/shipped) order is the normal counterpart of a sale — the ledger's
      // remaining-quantity tracking, not a review prompt, is what prevents double allocation.
      // Only a completion far older than the sale is suspicious (goods likely sold before the
      // ledger existed, so the remaining quantity is a phantom).
      const done=Boolean(o.done||o.outDate||o.inDate), dd=doneDate(o);
      const staleDone=Boolean(done && dd && isoDate(sale.date) && daysBetween(dd,sale.date)>STALE_DONE_DAYS);
      if (staleDone) issues.push(`완료 후 ${STALE_DONE_DAYS}일 넘은 건 — 이미 매각된 발주일 수 있어 확인 필요`);
      const reasons=manual?['담당자 직접 지정']:[vm.reason,im.reason];
      if (sale.supplier&&o.supplier&&vendorName(sale.supplier)===vendorName(o.supplier)) reasons.push('공급사 표기 일치');
      base.candidates.push({orderId:o.id,action:o.action,item:o.item,vendor:o.vendor,remaining:remainingQty,
        done,staleDone,crossFamily,packKg:oPack,unitOk:orderComparable,orderSnapshot:orderSnapshot(o,oPack),issues,hardBlocked,reasons,
        quantityDifference:crossFamily?null:remaining-remainingQty});
    }
    // kg↔L candidates are never auto-combined: their quantities are not on the sale's scale.
    const subset=uniqueSubset(base.candidates.filter(c=>!c.crossFamily),remaining);
    if (subset.kind==='unique') base.proposal=subset.sets[0].map(id=>{
      const c=base.candidates.find(x=>String(x.orderId)===String(id));
      return {orderId:id,baseQty:c.remaining};
    });
    const selected=base.candidates.filter(c=>base.proposal.some(p=>String(p.orderId)===String(c.orderId)));
    const status=!base.candidates.length?'NO_CANDIDATE':base.candidates.every(c=>c.crossFamily)?'REVIEW':subset.kind==='ambiguous'?'AMBIGUOUS':
      subset.kind==='too_many'?'REVIEW':subset.kind==='none'?'QUANTITY_REVIEW':
      base.issues.length||selected.some(c=>c.issues.length)?'REVIEW':'READY';
    return {...base,status,remaining,subsetKind:subset.kind};
  }
  // Returns a new ledger only. Apply and persist in one app-side transaction.
  // Does NOT alter physical receipt/shipment dates or done flags.
  function commit({sale,orders,ledger=[],aliases=emptyAliases(),allocations,actor,now,expectedOrders,
    reviewConfirmed=false,reviewReason='',eventId,expectedSourceSnapshot,manualOrderIds=[],packKgOf}) {
    if (!actor||!now||!eventId) throw Error('담당자·시각·고유 이벤트 ID 필수');
    if (ledger.some(e=>e.id===eventId)) throw Error('이벤트 ID 중복');
    const packKg=packKgResolver({packKgOf});
    const p=preview(sale,orders,ledger,aliases,{manualOrderIds,packKgOf});
    if (expectedSourceSnapshot!==p.sourceSnapshot) throw Error('미리보기 이후 매각 원본 변경 또는 스냅샷 누락');
    if (!p.sourceKey) throw Error('안정적인 원천 전표행 식별자 필요');
    if (['INVALID','SOURCE_CHANGED','ALREADY_LINKED','NO_CANDIDATE'].includes(p.status)) throw Error(p.status);
    if (p.issues.length || p.status!=='READY') {
      if (!reviewConfirmed||!reviewReason.trim()) throw Error('검토 확인 및 사유 필수');
    }
    // Missing or unconvertible units and dates require correction, not an unchecked confirmation.
    if (!p.unitOk||!isoDate(sale.date)) throw Error('원천 단위·날짜 보완 필요');
    const saleFactor=baseFactor(sale.unit,p.salePackKg);
    if (!allocations?.length) throw Error('배분할 항목 없음');
    const seen=new Set(), stored=[]; let sum=0;
    for (const a of allocations) {
      const id=String(a.orderId), c=p.candidates.find(x=>String(x.orderId)===id), o=orders.find(x=>String(x.id)===id);
      if (!c||!o||seen.has(id)) throw Error('잘못된/중복 배분 대상');
      seen.add(id);
      if (!c.unitOk) throw Error('발주/출고 단위 보완 필요');
      if (!orderStart(o)) throw Error('발주/접수일 보완 필요');
      if (!expectedOrders || expectedOrders[id]!==orderSnapshot(o,packKg(o.item,o.unit))) throw Error('미리보기 이후 대상 변경 또는 스냅샷 누락');
      if (!(Number.isFinite(a.baseQty)&&a.baseQty>0) || a.baseQty>c.remaining+1e-6) throw Error('대상 잔량 초과/잘못된 수량');
      if (c.issues.length && (!reviewConfirmed||!reviewReason.trim())) throw Error('후보 검토 사유 필수');
      if (c.issues.includes('M-210 행선지 확인 필요')) throw Error('M-210 행선지 보완 필요');
      // kg↔L: baseQty is on the order's scale, so the sale-side consumption must be stated separately —
      // saleQty in the sale's own unit as typed (e.g. 1 톤), saleBaseQty on the sale's base scale (1000).
      if (c.crossFamily) {
        if (!(Number.isFinite(+a.saleQty)&&+a.saleQty>0)) throw Error('단위 계열이 다른 배분은 매각 소진 수량 필수');
        const saleBaseQty=+a.saleQty*saleFactor;
        stored.push({orderId:a.orderId,baseQty:a.baseQty,saleQty:+a.saleQty,saleBaseQty});
        sum+=saleBaseQty;
      } else { stored.push({orderId:a.orderId,baseQty:a.baseQty}); sum+=a.baseQty; }
    }
    if (sum>p.remaining+1e-6) throw Error('매각 잔량 초과');
    return [...ledger,{id:eventId,version:VERSION,sourceKey:p.sourceKey,sourceSnapshot:p.sourceSnapshot,
      actor,createdAt:now,reviewReason,allocations:stored,reversedAt:null}];
  }
  function reverse(ledger,eventId,actor,now,reason) {
    if (!actor||!now||!reason?.trim()) throw Error('취소 담당자·시각·사유 필수');
    if (!ledger.some(e=>e.id===eventId&&!e.reversedAt)) throw Error('취소할 활성 배분 없음');
    return ledger.map(e=>e.id===eventId?{...e,reversedAt:now,reversedBy:actor,reversalReason:reason}:e);
  }
  return {VERSION,STALE_DONE_DAYS,compact,vendorName,cleanItem,itemForms,hasBounded,unit,amount,baseFactor,unitProblem,saleUsed,isoDate,regNo,vendorMatch,itemMatch,
    sourceKey,sourceSnapshot,orderSnapshot,orderStart,remainingOrder,uniqueSubset,preview,commit,reverse};
});
