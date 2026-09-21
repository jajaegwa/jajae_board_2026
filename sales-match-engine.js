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
  function unit(v) {
    const u = String(v ?? '').trim().toUpperCase();
    if (['KG','KGS','킬로그램'].includes(u)) return {family:'MASS', factor:1};
    if (['T','TON','TONNE','MT','톤'].includes(u)) return {family:'MASS', factor:1000};
    if (['G','그램'].includes(u)) return {family:'MASS', factor:0.001};
    if (['M','미터'].includes(u)) return {family:'LENGTH', factor:1};
    if (['EA','PCS','개'].includes(u)) return {family:'COUNT', factor:1};
    return null;
  }
  function amount(q, u) {
    const s = String(q ?? '').trim().replace(/,/g, '');
    if (!/^(?:\d+)(?:\.\d+)?$/.test(s) || !(Number(s)>0)) return null;
    const info = unit(u);
    return {value:Number(s)*(info?.factor || 1), family:info?.family || null};
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
  function sourceSnapshot(s) {
    return JSON.stringify([s.vendor,s.vendorRegNo||'',s.item,s.itemCode||'',s.qty,s.unit||'',s.date||'',s.destination||'']);
  }
  function orderSnapshot(o) {
    return JSON.stringify([o.id,o.action,o.vendor,o.vendorRegNo||'',o.item,o.itemCode||'',o.qty,o.unit||'',o.requestDate||'',o.orderDate||'',o.done,o.outDate||'',o.inDate||'',o.destination||'',o.m210Confirmed||false]);
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
  function remainingOrder(o, ledger) {
    const q=amount(o.qty,o.unit);
    return q ? Math.max(0,q.value-usedForOrder(ledger,o.id)) : 0;
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
  function preview(sale, orders, ledger=[], aliases=emptyAliases(), opts={}) {
    const manualIds=new Set((opts.manualOrderIds||[]).map(String));
    const qty=amount(sale.qty,sale.unit), key=sourceKey(sale);
    // hardBlocked (row-level and per candidate): conditions commit() rejects regardless of review
    // confirmation — the data must be corrected, so the UI must not auto-select these.
    const base={sourceKey:key,sourceSnapshot:sourceSnapshot(sale),candidates:[],proposal:[],issues:[],rejected:[],hardBlocked:[]};
    if (!qty) return {...base,status:'INVALID',issues:['수량은 양수여야 함; 반품/취소는 별도 정정 흐름 필요']};
    const prior=key?active(ledger).filter(e=>e.sourceKey===key):[];
    if (prior.some(e=>e.sourceSnapshot!==base.sourceSnapshot)) return {...base,status:'SOURCE_CHANGED',issues:['같은 전표행의 내용 변경; 기존 배분 정정 필요']};
    const allocated=prior.reduce((sum,e)=>sum+e.allocations.reduce((n,a)=>n+a.baseQty,0),0);
    const remaining=qty.value-allocated;
    if (remaining < -1e-6) return {...base,status:'SOURCE_CHANGED',issues:['매각수량보다 기존 배분이 큼']};
    if (Math.abs(remaining)<1e-6) return {...base,status:'ALREADY_LINKED',remaining:0};
    if (!key) base.issues.push('전표번호·전표행번호 누락: 거래 중복 여부 확인 필요');
    if (key && JSON.parse(key)[0]==='file-row') base.issues.push('파일행 식별만 가능: 다른 파일의 기존 반영과 중복 여부 검토 필요');
    if (!isoDate(sale.date)) { base.issues.push('매각일 누락 또는 오류'); base.hardBlocked.push('매각일 누락 또는 오류'); }
    if (!qty.family) { base.issues.push('매각 단위 확인 필요'); base.hardBlocked.push('매각 단위 확인 필요'); }
    for (const o of orders) {
      if (!['발주','직접출고'].includes(o.action)) continue;
      const manual=manualIds.has(String(o.id));
      const reject=reason=>base.rejected.push({orderId:o.id,reason});
      const vm=vendorMatch(sale,o,aliases), im=itemMatch(sale,o,aliases);
      if (vm.level==='blocked'||im.level==='blocked') { if (manual) reject(vm.level==='blocked'?vm.reason:im.reason); continue; }
      if (!manual && (vm.level==='none'||im.level==='none')) continue;
      const oq=amount(o.qty,o.unit), remainingQty=remainingOrder(o,ledger);
      if (!oq) { reject('발주/출고 수량 오류'); continue; }
      if (remainingQty<=1e-6) { reject('잔량 없음(이미 전부 배분됨)'); continue; }
      const issues=[], hardBlocked=[];
      if (qty.family && oq.family && qty.family!==oq.family) { reject('단위 종류 불일치(중량/길이/개수)'); continue; }
      if (!qty.family||!oq.family) issues.push('단위 확인 필요');
      if (!unit(o.unit)) hardBlocked.push('단위 확인 필요');
      const start=orderStart(o);
      if (!start) { issues.push('발주/접수일 확인 필요'); hardBlocked.push('발주/접수일 확인 필요'); }
      if (start && isoDate(sale.date) && sale.date<start) {
        if (!manual) { reject('매각일이 발주/접수일보다 앞섬'); continue; }
        issues.push('매각일이 발주/접수일보다 앞섬');
      }
      if (sale.destination && o.destination && compact(sale.destination)!==compact(o.destination)) { reject('행선지 불일치'); continue; }
      // M-210 (monthly import lot): the order must carry its per-case confirmation and a structured
      // destination. The sale side has no destination column today, so it is only compared when
      // present (above), never required — otherwise every M-210 sale stayed blocked forever.
      if (/(?:^|[^A-Z0-9])M[- ]?210(?:$|[^A-Z0-9])/i.test(sale.item+' '+o.item) &&
          (!o.m210Confirmed || !o.destination)) { issues.push('M-210 행선지 확인 필요'); hardBlocked.push('M-210 행선지 확인 필요'); }
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
        done,staleDone,orderSnapshot:orderSnapshot(o),issues,hardBlocked,reasons,
        quantityDifference:remaining-remainingQty});
    }
    const subset=uniqueSubset(base.candidates,remaining);
    if (subset.kind==='unique') base.proposal=subset.sets[0].map(id=>{
      const c=base.candidates.find(x=>String(x.orderId)===String(id));
      return {orderId:id,baseQty:c.remaining};
    });
    const selected=base.candidates.filter(c=>base.proposal.some(p=>String(p.orderId)===String(c.orderId)));
    const status=!base.candidates.length?'NO_CANDIDATE':subset.kind==='ambiguous'?'AMBIGUOUS':
      subset.kind==='too_many'?'REVIEW':subset.kind==='none'?'QUANTITY_REVIEW':
      base.issues.length||selected.some(c=>c.issues.length)?'REVIEW':'READY';
    return {...base,status,remaining,subsetKind:subset.kind};
  }
  // Returns a new ledger only. Apply and persist in one app-side transaction.
  // Does NOT alter physical receipt/shipment dates or done flags.
  function commit({sale,orders,ledger=[],aliases=emptyAliases(),allocations,actor,now,expectedOrders,
    reviewConfirmed=false,reviewReason='',eventId,expectedSourceSnapshot,manualOrderIds=[]}) {
    if (!actor||!now||!eventId) throw Error('담당자·시각·고유 이벤트 ID 필수');
    if (ledger.some(e=>e.id===eventId)) throw Error('이벤트 ID 중복');
    const p=preview(sale,orders,ledger,aliases,{manualOrderIds});
    if (expectedSourceSnapshot!==p.sourceSnapshot) throw Error('미리보기 이후 매각 원본 변경 또는 스냅샷 누락');
    if (!p.sourceKey) throw Error('안정적인 원천 전표행 식별자 필요');
    if (['INVALID','SOURCE_CHANGED','ALREADY_LINKED','NO_CANDIDATE'].includes(p.status)) throw Error(p.status);
    if (p.issues.length || p.status!=='READY') {
      if (!reviewConfirmed||!reviewReason.trim()) throw Error('검토 확인 및 사유 필수');
    }
    // Missing units and dates require correction, not an unchecked confirmation.
    if (!unit(sale.unit)||!isoDate(sale.date)) throw Error('원천 단위·날짜 보완 필요');
    if (!allocations?.length) throw Error('배분할 항목 없음');
    const seen=new Set(); let sum=0;
    for (const a of allocations) {
      const id=String(a.orderId), c=p.candidates.find(x=>String(x.orderId)===id), o=orders.find(x=>String(x.id)===id);
      if (!c||!o||seen.has(id)) throw Error('잘못된/중복 배분 대상');
      seen.add(id);
      if (!unit(o.unit)) throw Error('발주/출고 단위 보완 필요');
      if (!orderStart(o)) throw Error('발주/접수일 보완 필요');
      if (!expectedOrders || expectedOrders[id]!==orderSnapshot(o)) throw Error('미리보기 이후 대상 변경 또는 스냅샷 누락');
      if (!(Number.isFinite(a.baseQty)&&a.baseQty>0) || a.baseQty>c.remaining+1e-6) throw Error('대상 잔량 초과/잘못된 수량');
      if (c.issues.length && (!reviewConfirmed||!reviewReason.trim())) throw Error('후보 검토 사유 필수');
      if (c.issues.includes('M-210 행선지 확인 필요')) throw Error('M-210 행선지 보완 필요');
      sum+=a.baseQty;
    }
    if (sum>p.remaining+1e-6) throw Error('매각 잔량 초과');
    return [...ledger,{id:eventId,version:VERSION,sourceKey:p.sourceKey,sourceSnapshot:p.sourceSnapshot,
      actor,createdAt:now,reviewReason,allocations:allocations.map(a=>({...a})),reversedAt:null}];
  }
  function reverse(ledger,eventId,actor,now,reason) {
    if (!actor||!now||!reason?.trim()) throw Error('취소 담당자·시각·사유 필수');
    if (!ledger.some(e=>e.id===eventId&&!e.reversedAt)) throw Error('취소할 활성 배분 없음');
    return ledger.map(e=>e.id===eventId?{...e,reversedAt:now,reversedBy:actor,reversalReason:reason}:e);
  }
  return {VERSION,STALE_DONE_DAYS,compact,vendorName,cleanItem,itemForms,hasBounded,unit,amount,isoDate,regNo,vendorMatch,itemMatch,
    sourceKey,sourceSnapshot,orderSnapshot,orderStart,remainingOrder,uniqueSubset,preview,commit,reverse};
});
