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
  // Normalized business content of a sale row: vendor name, item name, quantity in base unit,
  // unit family and sale date. Only the always-mapped columns take part (registration number and
  // ERP code are optional columns, so a file exported without them must still yield the same
  // identity). Rows that agree on this tuple are the same sale whichever file they arrived in.
  function contentFields(s) {
    const q=amount(s.qty,s.unit);
    return [vendorName(s.vendor), compact(cleanItem(s.item)), q?q.value:String(s.qty??''), q?q.family||'':'', isoDate(s.date)];
  }
  const contentTuple = s => JSON.stringify(contentFields(s));
  // Content-keyed rows need an ordinal so two genuinely identical rows in one file (same vendor,
  // item, quantity and date) stay distinct: the n-th identical row gets ordinal n.
  function withContentOrdinals(sales) {
    const seen=new Map();
    return sales.map(s=>{
      const t=contentTuple(s), n=(seen.get(t)||0)+1; seen.set(t,n);
      return {...s,contentOrdinal:n};
    });
  }
  const hasOrdinal = s => Number.isInteger(s.contentOrdinal) && s.contentOrdinal>=1;
  // Content identity of a sale, independent of file bytes and of which optional columns were mapped.
  function contentKey(s) {
    if (!s.issuerId || !hasOrdinal(s)) return null;
    return JSON.stringify(['content',String(s.issuerId),contentTuple(s),s.contentOrdinal]);
  }
  // Real transaction line (document number + line) preferred; otherwise the content key. File
  // bytes are never part of the identity: they change on every re-export or re-save.
  function sourceKey(s) {
    if (s.sourceSystem && s.issuerId && s.documentNo && s.documentLine)
      return JSON.stringify(['transaction',s.sourceSystem,s.issuerId,s.documentNo,s.documentLine].map(String));
    return contentKey(s);
  }
  const keyKind = key => (String(key||'').match(/^\["([\w-]+)"/)||[])[1]||'';
  // packKg (pack→kg factor actually used) is part of the snapshot only when a conversion applied, so
  // a later master-data edit is detected as a change instead of silently moving remaining quantities.
  // Records without a conversion keep the original shape, so ledgers written before this existed match.
  const withPack = (fields, packKg) => JSON.stringify(packKg ? [...fields, packKg] : fields);
  function sourceSnapshot(s, packKg) {
    return withPack([s.vendor,s.vendorRegNo||'',s.item,s.itemCode||'',s.qty,s.unit||'',s.date||'',s.destination||''], packKg);
  }
  // Rebuild a sale-shaped object from a ledger entry's stored snapshot (same field order as
  // sourceSnapshot; a trailing packKg element, when present, is not needed for identity).
  function saleFromSnapshot(snapshot) {
    let f; try { f=JSON.parse(snapshot); } catch (_) { return null; }
    if (!Array.isArray(f) || f.length<7) return null;
    return {vendor:f[0],vendorRegNo:f[1],item:f[2],itemCode:f[3],qty:f[4],unit:f[5],date:f[6],destination:f[7]||''};
  }
  // Parsed content of a ledger entry, recomputed from its raw snapshot with the current normalizers
  // (a normalizer change must not orphan stored entries), cached per snapshot string.
  const infoBySnapshot=new Map();
  function entryInfo(e) {
    const snap=String(e.sourceSnapshot||'');
    if (infoBySnapshot.has(snap)) return infoBySnapshot.get(snap);
    if (infoBySnapshot.size>5000) infoBySnapshot.clear();
    const sale=saleFromSnapshot(snap), fields=sale?contentFields(sale):null;
    const info=fields?{sale,fields,tuple:JSON.stringify(fields)}:null;
    infoBySnapshot.set(snap,info); return info;
  }
  const entryTuple = e => (entryInfo(e)||{}).tuple||null;
  // Durable content identity of an entry = (recomputed tuple, stored contentOrdinal). Ordinals are
  // ledger-scoped per content: every active entry of one sale (partial allocations share a
  // sourceKey) carries the same ordinal, and different sales of identical content carry different
  // ones. Content-keyed sales bring their file ordinal; slip-keyed sales get the lowest unused one
  // at commit time, since ordinals inside their own file are unrelated to the ledger's.
  const entryOrdinal = e => hasOrdinal(e) ? e.contentOrdinal : null;
  function usedOrdinals(ledger, tuple) {
    const used=new Set();
    for (const e of active(ledger)) { const own=entryOrdinal(e); if (own && entryTuple(e)===tuple) used.add(own); }
    return used;
  }
  const lowestFree = (used, from=1) => { let n=from; while (used.has(n)) n++; return n; };
  // Ordinals other rows of the current upload already claim for this content (their preview keys).
  // Parsed once per batchKeys array (the app passes the same array to every row of a recompute).
  const batchIndexCache=new WeakMap();
  function batchOrdinals(batchKeys, tuple) {
    if (!Array.isArray(batchKeys)) return new Set();
    let byTuple=batchIndexCache.get(batchKeys);
    if (!byTuple) {
      byTuple=new Map();
      for (const k of batchKeys) {
        if (keyKind(k)!=='content') continue;
        let a; try { a=JSON.parse(k); } catch (_) { continue; }
        if (!Number.isInteger(a[3])) continue;
        if (!byTuple.has(a[2])) byTuple.set(a[2],new Set());
        byTuple.get(a[2]).add(a[3]);
      }
      batchIndexCache.set(batchKeys,byTuple);
    }
    return new Set(byTuple.get(tuple)||[]);
  }
  // Entries written before contentOrdinal existed (the retired 'file-row' key, or transaction keys)
  // get one so a re-upload in another file or with other columns is recognised as already linked.
  // Entries sharing a sourceKey share the ordinal; otherwise the lowest ordinal unused for that
  // content, in ledger order. Entries that already carry one keep it. Idempotent; returns the same
  // array when nothing needs migrating.
  function migrateLedger(ledger) {
    const all=ledger||[], used=new Map(), byKey=new Map();
    if (!all.some(e=>!e.reversedAt && !entryOrdinal(e) && entryTuple(e))) return ledger;   // steady state: nothing to do (sync hot path)
    const usedFor=t=>{ if (!used.has(t)) used.set(t,new Set()); return used.get(t); };
    for (const e of all) {
      const own=entryOrdinal(e); if (e.reversedAt || !own) continue;
      const t=entryTuple(e); if (!t) continue;
      usedFor(t).add(own); if (!byKey.has(e.sourceKey)) byKey.set(e.sourceKey,own);
    }
    let changed=false;
    const out=all.map(e=>{
      if (e.reversedAt || entryOrdinal(e)) return e;
      const t=entryTuple(e); if (!t) return e;
      let n=byKey.get(e.sourceKey);
      if (!n) { n=lowestFree(usedFor(t)); usedFor(t).add(n); byKey.set(e.sourceKey,n); }
      changed=true;
      return {...e,contentOrdinal:n};
    });
    return changed?out:ledger;
  }
  // Ordinal for a sale the operator declares a separate transaction although an entry with the
  // same content exists: the lowest ordinal unused in the ledger and unclaimed by other rows of the
  // same upload (otherKeys), at least the sale's own. The app assigns it once, on declaration.
  function nextFreeOrdinal(sale, ledger, otherKeys=[]) {
    const t=contentTuple(sale), used=usedOrdinals(ledger,t);
    for (const n of batchOrdinals(otherKeys,t)) used.add(n);
    return lowestFree(used, hasOrdinal(sale)?sale.contentOrdinal:1);
  }
  // A content match must not join two different legal entities or ERP items that happen to share a
  // name: a registration number or item code present on both sides and different rules it out.
  function compatibleEntry(sale, e) {
    const prev=(entryInfo(e)||{}).sale; if (!prev) return true;
    const a=regNo(sale.vendorRegNo||sale.vendor), b=regNo(prev.vendorRegNo||prev.vendor);
    if (a && b && a!==b) return false;
    if (sale.itemCode && prev.itemCode && compact(sale.itemCode)!==compact(prev.itemCode)) return false;
    return true;
  }
  const sameContent = (sale, tuple, e) => hasOrdinal(sale) && entryOrdinal(e)===sale.contentOrdinal && entryTuple(e)===tuple && compatibleEntry(sale,e);
  // Active entries for the same vendor, item and sale date but a different quantity: a re-issued
  // or corrected file would look like this, so the row is not auto-allocated (operator decides).
  // Entries whose key is in excludeKeys (the other rows of the same upload) are not suspects: two
  // different-quantity rows in one file are plainly two sales.
  function similarPrior(sale, ledger, excludeKeys=[]) {
    const mine=contentFields(sale), skip=new Set(excludeKeys);
    if (!mine[4]) return [];
    return active(ledger).filter(e=>{
      if (skip.has(e.sourceKey)) return false;
      const t=(entryInfo(e)||{}).fields; if (!t) return false;
      return t[0]===mine[0] && t[1]===mine[1] && t[4]===mine[4] && (t[2]!==mine[2] || t[3]!==mine[3]) && compatibleEntry(sale,e);
    });
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
  // Exact-sum subsets of candidate remaining quantities. When several subsets reach the target the
  // oldest orders win (first-in first-out, decided 2026-09-23): each subset is read as its members
  // sorted by start date then id, and the lexicographically earliest subset is proposed — so with
  // three 1,000 kg orders and a 2,000 kg sale the two oldest are consumed first, and a 1,000+2,000
  // pair dated before a single 3,000 kg order beats it. Enumeration is bounded by the 12-candidate cap.
  // A subset whose members all commit cleanly ranks before one carrying a review issue (e.g. a
  // completion far older than the sale): such an order is by nature the oldest and would otherwise
  // win every tie, turning an exact match into a review.
  const SUBSET_CAP = 12;
  // Exported so the caller's own first-in-first-out fallback consumes orders in the same sequence.
  const orderRank = c => (c.start || '') + '|' + String(c.orderId).padStart(12, '0');
  const issueCount = set => set.filter(c => (c.issues || []).length).length;
  function uniqueSubset(candidates, target) {
    if (candidates.length>SUBSET_CAP) return {kind:'too_many', sets:[]};
    const sets=[];
    function visit(i, sum, picked) {
      if (Math.abs(sum-target)<1e-6 && picked.length) {sets.push(picked);return;}
      if (i===candidates.length || sum>target+1e-6) return;
      visit(i+1,sum,picked);
      visit(i+1,sum+candidates[i].remaining,[...picked,candidates[i]]);
    }
    visit(0,0,[]);
    if (!sets.length) return {kind:'none', sets:[]};
    const ids = set => set.map(c=>c.orderId);
    if (sets.length===1) return {kind:'unique', sets:[ids(sets[0])]};
    const ranked = sets.map(set => ({set, key: set.map(orderRank).sort()}));
    ranked.sort((a,b) => {
      const ia = issueCount(a.set), ib = issueCount(b.set);
      if (ia !== ib) return ia - ib;
      for (let k=0; k<Math.max(a.key.length,b.key.length); k++) {
        if (a.key[k]===undefined) return -1;   // shorter prefix (fewer orders) first when otherwise equal
        if (b.key[k]===undefined) return 1;
        if (a.key[k]!==b.key[k]) return a.key[k]<b.key[k]?-1:1;
      }
      return 0;
    });
    return {kind:'fifo', sets:[ids(ranked[0].set)]};
  }
  // opts.batchKeys: source keys of every row in the current upload, so sibling rows committed
  // earlier in the same batch are not reported as duplicate suspects.
  // opts.separateSale: the operator declares this row a separate transaction even though an entry
  // with identical content exists (same item, quantity and day sold twice, arriving in different
  // files). The caller has already given a content-keyed row its new ordinal (nextFreeOrdinal);
  // here the row skips the content match and carries a review issue.
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
    const separate=Boolean(opts.separateSale);
    // Ordinals not available to a new slip entry of this content: used in the ledger, or claimed by
    // content-keyed rows of the same upload.
    const takenOrdinals=()=>{ const t=contentTuple(sale), u=usedOrdinals(ledger,t); for (const n of batchOrdinals(opts.batchKeys,t)) u.add(n); return u; };
    const packKg=packKgResolver(opts), salePack=packKg(sale.item,sale.unit);
    const qty=amount(sale.qty,sale.unit,salePack), key=sourceKey(sale);
    // hardBlocked (row-level and per candidate): conditions commit() rejects regardless of review
    // confirmation — the data must be corrected, so the UI must not auto-select these.
    const base={sourceKey:key,contentOrdinal:null,sourceSnapshot:sourceSnapshot(sale,salePack),salePackKg:salePack,unitOk:false,candidates:[],proposal:[],issues:[],rejected:[],hardBlocked:[],duplicateSuspect:false,linkedByContent:false};
    if (!qty) return {...base,status:'INVALID',issues:['수량은 양수여야 함; 반품/취소는 별도 정정 흐름 필요']};
    const kind=keyKind(key), tuple=contentTuple(sale);
    // A separate-sale ordinal was fixed by the caller against its own view of the ledger; if this
    // ledger (fresh from the server) already uses it, two sales would share an identity.
    if (separate && kind==='content' && usedOrdinals(ledger,tuple).has(sale.contentOrdinal))
      return {...base,status:'SOURCE_CHANGED',issues:['별개 거래 순번이 그 사이 다른 반영에 쓰임; 미리보기를 다시 여세요']};
    // Prior entries. A content-keyed sale takes every entry of the same content and ordinal. A
    // slip-keyed sale takes its own line's entries; when it has none, it may be the slip form of a
    // sale first linked from a file without the line column, so it joins the entries that were never
    // slip-identified — but only when that is unambiguous: exactly one such sale (ordinal group) of
    // this content not already claimed by another slip. Slip file ordinals say nothing about the
    // ledger's, so they are never used to pick one of several.
    let prior=[];
    const nonSlipSame=e=>keyKind(e.sourceKey)!=='transaction' && entryOrdinal(e) && entryTuple(e)===tuple && compatibleEntry(sale,e);
    if (kind==='transaction') {
      prior=active(ledger).filter(e=>e.sourceKey===key);
      const ownOrdinal=(prior.find(hasOrdinal)||{}).contentOrdinal;
      if (ownOrdinal) prior=prior.concat(active(ledger).filter(e=>nonSlipSame(e) && e.contentOrdinal===ownOrdinal));
      else if (!separate) {
        const claimed=new Set(active(ledger).filter(e=>keyKind(e.sourceKey)==='transaction' && entryOrdinal(e) && entryTuple(e)===tuple).map(e=>e.contentOrdinal));
        const groups=new Map();
        for (const e of active(ledger)) if (nonSlipSame(e) && !claimed.has(e.contentOrdinal)) { if (!groups.has(e.contentOrdinal)) groups.set(e.contentOrdinal,[]); groups.get(e.contentOrdinal).push(e); }
        if (groups.size===1) prior=[...groups.values()][0];
        else if (groups.size>1) { base.issues.push(`전표행 없이 반영된 같은 내용의 이력이 ${groups.size}건 있어 어느 건인지 확인 필요(반영 이력 참고, 새 거래면 [별개 거래로 반영])`); base.duplicateSuspect=true; base.linkedByContent=true; }
      }
    } else prior=separate?[]:active(ledger).filter(e=>sameContent(sale,tuple,e));
    const byContent=Boolean(prior.length) && (kind!=='transaction' || !prior.some(e=>e.sourceKey===key));
    // The ordinal a ledger entry for this sale carries (commit persists it): the one its prior
    // entries use (partial allocation, or a slip re-upload of a content-linked sale), else for a
    // slip-keyed sale the lowest ordinal unused for this content (its file ordinal is unrelated to
    // the ledger's), else the sale's own file ordinal, which is what a re-upload will bring again.
    const priorOrdinal=(prior.find(hasOrdinal)||{}).contentOrdinal;
    base.contentOrdinal=priorOrdinal || (kind==='transaction' ? lowestFree(takenOrdinals()) : hasOrdinal(sale)?sale.contentOrdinal:null);
    // Only a transaction key can carry changed content: a content key already embeds vendor,
    // item, quantity and date, so a snapshot difference there is cosmetic (spelling, unit casing).
    if (kind==='transaction' && prior.some(e=>e.sourceKey===key && e.sourceSnapshot!==base.sourceSnapshot)) return {...base,status:'SOURCE_CHANGED',issues:['같은 전표행의 내용 변경; 기존 배분 정정 필요']};
    const allocated=prior.reduce((sum,e)=>sum+e.allocations.reduce((n,a)=>n+saleUsed(a),0),0);
    const remaining=qty.value-allocated;
    if (remaining < -1e-6) return {...base,status:'SOURCE_CHANGED',issues:['매각수량보다 기존 배분이 큼']};
    if (Math.abs(remaining)<1e-6) {
      // Matched by content only: a genuine second sale with identical content in a separate file
      // lands here too, so say how the match was made; linkedByContent lets the UI offer
      // opts.separateSale as the way to link it anyway.
      return {...base,status:'ALREADY_LINKED',remaining:0,linkedByContent:byContent,
        issues:byContent?['업체·품목·수량·매각일이 같은 기존 반영과 동일 판정(전표행이 아니라 파일 내 같은 내용 순번 기준): 같은 날 같은 수량의 별개 거래라면 [별개 거래로 반영]을 쓰세요']:[]};
    }
    if (!key) base.issues.push('전표번호·전표행번호 누락: 거래 중복 여부 확인 필요');
    if (separate) base.issues.push('같은 내용의 기존 반영이 있으나 별개 거래로 반영(담당자 확인)');
    // Content-identified rows: flag a same-day sale of the same item already in the ledger with a
    // different quantity (re-issued/corrected file?). duplicateSuspect lets bulk automation skip it.
    if (kind==='content' && similarPrior(sale,ledger,opts.batchKeys||[]).length) {
      base.issues.push('같은 매각일·업체·품목의 기존 반영 있음(수량 다름): 재발행·정정 여부 확인 필요');
      base.duplicateSuspect=true;
    }
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
      base.candidates.push({orderId:o.id,action:o.action,item:o.item,vendor:o.vendor,remaining:remainingQty,start,
        done,staleDone,crossFamily,packKg:oPack,unitOk:orderComparable,orderSnapshot:orderSnapshot(o,oPack),issues,hardBlocked,reasons,
        quantityDifference:crossFamily?null:remaining-remainingQty});
    }
    // kg↔L candidates are never auto-combined: their quantities are not on the sale's scale.
    // Hard-blocked candidates (blank unit, missing start date, M-210 without destination) can never
    // be committed, so they take no part in the proposal either: with an old unit-less order beside
    // a proper one of the same quantity, the proper one is proposed instead of the row being stuck.
    // They stay listed (with their issue) so the operator sees why they were passed over.
    const nonCross=base.candidates.filter(c=>!c.crossFamily), committable=nonCross.filter(c=>!c.hardBlocked.length);
    const subset=uniqueSubset(committable,remaining);
    // No committable combination, but one exists once the blocked candidates are counted: the row
    // needs data fixed (unit, date, destination), not a quantity decision — say so in the status.
    const blockedExact=subset.kind==='none' && committable.length<nonCross.length && ['unique','fifo'].includes(uniqueSubset(nonCross,remaining).kind);
    if (subset.kind==='unique'||subset.kind==='fifo') base.proposal=subset.sets[0].map(id=>{
      const c=base.candidates.find(x=>String(x.orderId)===String(id));
      // A FIFO pick is a proposal like any other, but the reason says so, so the operator (and the
      // 근거 column) can see that older orders were preferred over an equally valid combination.
      if (subset.kind==='fifo') c.reasons.push('같은 수량 후보 여러 건 — 오래된 발주부터 배분(선입선출)');
      return {orderId:id,baseQty:c.remaining};
    });
    const selected=base.candidates.filter(c=>base.proposal.some(p=>String(p.orderId)===String(c.orderId)));
    const status=!base.candidates.length?'NO_CANDIDATE':base.candidates.every(c=>c.crossFamily)?'REVIEW':
      !committable.length||blockedExact?'REVIEW':   // candidates need data fixed first — not a quantity question
      subset.kind==='too_many'?'REVIEW':subset.kind==='none'?'QUANTITY_REVIEW':
      base.issues.length||selected.some(c=>c.issues.length)?'REVIEW':'READY';
    return {...base,status,remaining,subsetKind:subset.kind};
  }
  // Returns a new ledger only. Apply and persist in one app-side transaction.
  // Does NOT alter physical receipt/shipment dates or done flags.
  function commit({sale,orders,ledger=[],aliases=emptyAliases(),allocations,actor,now,expectedOrders,
    reviewConfirmed=false,reviewReason='',eventId,expectedSourceSnapshot,manualOrderIds=[],batchKeys=[],separateSale=false,packKgOf}) {
    if (!actor||!now||!eventId) throw Error('담당자·시각·고유 이벤트 ID 필수');
    if (ledger.some(e=>e.id===eventId)) throw Error('이벤트 ID 중복');
    const packKg=packKgResolver({packKgOf});
    const p=preview(sale,orders,ledger,aliases,{manualOrderIds,batchKeys,separateSale,packKgOf});
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
    return [...ledger,{id:eventId,version:VERSION,sourceKey:p.sourceKey,contentOrdinal:p.contentOrdinal||undefined,sourceSnapshot:p.sourceSnapshot,
      actor,createdAt:now,reviewReason,allocations:stored,reversedAt:null}];
  }
  function reverse(ledger,eventId,actor,now,reason) {
    if (!actor||!now||!reason?.trim()) throw Error('취소 담당자·시각·사유 필수');
    if (!ledger.some(e=>e.id===eventId&&!e.reversedAt)) throw Error('취소할 활성 배분 없음');
    return ledger.map(e=>e.id===eventId?{...e,reversedAt:now,reversedBy:actor,reversalReason:reason}:e);
  }
  return {VERSION,STALE_DONE_DAYS,SUBSET_CAP,orderRank,compact,vendorName,cleanItem,itemForms,hasBounded,unit,amount,baseFactor,unitProblem,saleUsed,isoDate,regNo,vendorMatch,itemMatch,
    contentFields,contentTuple,withContentOrdinals,contentKey,sourceKey,keyKind,sourceSnapshot,migrateLedger,nextFreeOrdinal,similarPrior,orderSnapshot,orderStart,remainingOrder,uniqueSubset,preview,commit,reverse};
});
