/**
 * Slot Renderer: LLM không viết con số, chỉ viết slot {{...}}; code điền số thật từ Fact Sheet và FT-Salary/ROI.
 * Nhờ vậy số liệu trong văn bản đúng theo thiết kế (không thể bịa), trích dẫn [F#] luôn trỏ đúng mã có thật,
 * và model nhỏ không phải chép lại chuỗi số dài (nguyên nhân chính gây lặp và cắt cụt ở bản 3B).
 *
 * Slot hợp lệ:
 *   {{F2}}            giá trị fact kèm đơn vị và mã: "12,4 triệu/tháng [F2]"
 *   {{F2.range}}      khoảng của fact: "10-15 triệu/tháng [F2]"; {{F2.low}} / {{F2.high}} cận dưới / cận trên
 *   {{P50.start}}     lương khởi điểm của kịch bản (P75 = Positive, P50 = Neutral, P25 = Risk)
 *   {{P50.year5}} {{P50.roi}} {{P50.payback}} {{P50.cash}} {{P50.family}} {{P50.gap}}
 *   {{start}} ...     dạng rút gọn trong phần viết riêng một kịch bản: tự hiểu là kịch bản đang viết
 *   {{growth}}        tăng lương danh nghĩa ngành mỗi năm, {{period}} giai đoạn đo
 *   {{score}}         điểm thi dự kiến người dùng nhập
 */

const SCENARIO_KEY = { P75: 'Positive', P50: 'Neutral', P25: 'Risk' };
const PCT_OF = { Positive: 'P75', Neutral: 'P50', Risk: 'P25' };
const QUANT_FIELDS = ['start', 'year5', 'roi', 'payback', 'cash', 'family', 'gap'];
const SLOT_RE = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

/** Số kiểu Việt: 12.4 -> "12,4"; số nguyên giữ nguyên; âm dùng dấu "-" liền số */
const vn = (n) => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  const r = Math.round(n * 100) / 100;
  return String(r).replace('.', ',');
};

const UNIT_TEXT = { 'điểm/30': 'điểm', 'triệu/tháng': 'triệu/tháng', tin: 'tin tuyển dụng', '%': '%', 'triệu VNĐ': 'triệu đồng' };
const withUnit = (v, unit) => {
  const u = UNIT_TEXT[unit] ?? unit ?? '';
  if (!u) return vn(v);
  return u === '%' ? `${vn(v)}%` : `${vn(v)} ${u}`;
};

/**
 * @param {object} prep  kết quả simulationRunner.prepare (factSheet, quant, cleanData)
 * @returns {{slots: Map<string,{text:string, value:number|null, desc:string}>, lensYears:number}}
 */
const buildSlots = (prep) => {
  const slots = new Map();
  const add = (key, text, value, desc) => { if (text) slots.set(key, { text, value, desc }); };

  for (const f of prep.factSheet?.facts || []) {
    if (typeof f.value !== 'number') continue;
    add(f.id, `${withUnit(f.value, f.unit)} [${f.id}]`, f.value, f.label);
    if (Array.isArray(f.range) && f.range.length === 2) {
      const u = UNIT_TEXT[f.unit] ?? f.unit ?? '';
      const rangeText = u === '%' ? `${vn(f.range[0])}-${vn(f.range[1])}%` : `${vn(f.range[0])}-${vn(f.range[1])} ${u}`.trim();
      add(`${f.id}.range`, `${rangeText} [${f.id}]`, null, `khoảng P25-P75 của ${f.id}`);
      add(`${f.id}.low`, `${withUnit(f.range[0], f.unit)} [${f.id}]`, f.range[0], `cận dưới (P25) của ${f.id}`);
      add(`${f.id}.high`, `${withUnit(f.range[1], f.unit)} [${f.id}]`, f.range[1], `cận trên (P75) của ${f.id}`);
    }
  }

  const q = prep.quant;
  const lens = q?.assumptions?.lensYears || 20;
  for (const [pct, type] of Object.entries(SCENARIO_KEY)) {
    const s = q?.scenarios?.[type];
    if (!s) continue;
    const label = { P75: 'Tối ưu P75', P50: 'Cân bằng P50', P25: 'Thận trọng P25' }[pct];
    add(`${pct}.start`, `${vn(s.salary?.startMonthlyMillion)} triệu/tháng`, s.salary?.startMonthlyMillion, `${label}: lương khởi điểm`);
    add(`${pct}.year5`, `${vn(s.salary?.year5MonthlyMillion)} triệu/tháng`, s.salary?.year5MonthlyMillion, `${label}: lương sau 5 năm`);
    if (s.roi) {
      const roiPct = Math.round(s.roi.ratio * 100);
      add(`${pct}.roi`, `${roiPct}%`, roiPct, `${label}: ROI ${lens} năm`);
      add(`${pct}.payback`, s.roi.paybackYearFromNow ? `năm thứ ${s.roi.paybackYearFromNow}` : `sau hơn ${lens} năm`,
        s.roi.paybackYearFromNow || null, `${label}: thời điểm hoàn vốn`);
    }
    const a = s.affordability;
    if (a) {
      add(`${pct}.cash`, `${vn(a.cashNeedPerYearMillion)} triệu/năm`, a.cashNeedPerYearMillion, `${label}: nhu cầu tiền mặt mỗi năm`);
      add(`${pct}.family`, `${vn(a.familyCapacityPerYearMillion)} triệu/năm`, a.familyCapacityPerYearMillion, `${label}: khả năng chi của gia đình mỗi năm`);
      if (!a.affordable && a.gapPerYearMillion > 0) {
        add(`${pct}.gap`, `${vn(a.gapPerYearMillion)} triệu/năm`, a.gapPerYearMillion, `${label}: phần thiếu so với khả năng gia đình mỗi năm`);
      }
    }
  }
  if (typeof q?.market?.salaryGrowthPercentPerYear === 'number') {
    add('growth', `${vn(q.market.salaryGrowthPercentPerYear)}%/năm`, q.market.salaryGrowthPercentPerYear, 'tăng lương danh nghĩa ngành mỗi năm');
    if (Array.isArray(q.market.period)) add('period', q.market.period.join('-'), null, 'giai đoạn đo tăng lương');
  }
  const score = prep.cleanData?.expectedScore;
  if (typeof score === 'number') add('score', `${vn(score)} điểm`, score, 'điểm thi dự kiến của người học');

  // Kết luận định tính do code tính sẵn: model nhỏ (và cả teacher) từng so sánh sai hai con số
  // (gia đình chi được 300 triệu/năm > nhu cầu 81 triệu/năm mà vẫn viết "áp lực tài chính lớn")
  const verdicts = {};
  for (const [pct, type] of Object.entries(SCENARIO_KEY)) {
    const s = q?.scenarios?.[type];
    if (!s) continue;
    const a = s.affordability;
    const money = a ? (a.affordable ? 'gia đình ĐỦ khả năng chi trả nhu cầu tiền mặt' : `gia đình KHÔNG ĐỦ khả năng chi trả, thiếu {{${pct}.gap}}`) : null;
    const roiPct = s.roi ? Math.round(s.roi.ratio * 100) : null;
    const roi = roiPct === null ? null : roiPct < 0 ? 'ROI ÂM: khoản học chưa sinh lời trong 20 năm' : roiPct < 50 ? 'ROI dương nhưng thấp' : 'ROI dương, khoản học sinh lời';
    const payback = s.roi ? (s.roi.paybackYearFromNow ? `hoàn vốn vào {{${pct}.payback}}` : `chưa hoàn vốn trong ${lens} năm`) : null;
    verdicts[pct] = [money, roi, payback].filter(Boolean).join('; ');
  }
  return { slots, lensYears: lens, verdicts };
};

/** Khóa đầy đủ của slot (giải {{start}} thành {{P50.start}} khi đang viết kịch bản Neutral) */
const resolveKey = (key, scenarioType) => {
  if (QUANT_FIELDS.includes(key) && scenarioType) return `${PCT_OF[scenarioType]}.${key}`;
  return key;
};

/** Điền slot vào một chuỗi; trả về văn bản và danh sách slot không tồn tại */
const renderText = (text, { slots }, scenarioType = null) => {
  if (typeof text !== 'string') return { text, unknown: [], used: [] };
  const unknown = [];
  const used = [];
  let out = '';
  let last = 0;
  const re = new RegExp(SLOT_RE.source, 'g');
  let m;
  while ((m = re.exec(text))) {
    out += text.slice(last, m.index);
    last = re.lastIndex;
    const full = resolveKey(m[1], scenarioType);
    const slot = slots.get(full);
    if (!slot) { unknown.push(m[1]); out += m[0]; continue; }
    used.push(full);
    // Viết tự nhiên "{{F4}} tin tuyển dụng", "{{start}} triệu/tháng": slot đã có đơn vị nên nuốt phần đơn vị lặp ngay sau
    const unit = slot.text.replace(/^-?[\d,]+(?:-[\d,]+)?\s*/, '').replace(/\s*\[F\d+\]$/, '').trim();
    if (unit && /^[-\d]/.test(slot.text)) {
      const firstWord = unit.split(/[\s/]/)[0];
      const rest = text.slice(last);
      const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      const dup = [unit, firstWord].filter(Boolean)
        .map(u => rest.match(new RegExp(`^\\s*${esc(u)}(?![\\p{L}\\d])`, 'u')))
        .find(Boolean);
      if (dup) last += dup[0].length;
    }
    out += slot.text;
  }
  out += text.slice(last);
  // Mã [F#] đã nằm trong slot: bỏ mã trùng model viết thêm ngay sau ("{{F2}} [F2]")
  return { text: out.replace(/(\[F\d+\])\s*\1/g, '$1'), unknown, used };
};

/** Điền slot cho mọi chuỗi trong JSON (giữ nguyên cấu trúc) */
const renderJson = (json, ctx, scenarioType = null) => {
  const unknown = [];
  const used = [];
  const walk = (v) => {
    if (typeof v === 'string') {
      const r = renderText(v, ctx, scenarioType);
      unknown.push(...r.unknown);
      used.push(...r.used);
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'type' ? x : walk(x)]));
    return v;
  };
  return { json: walk(json), unknown, used };
};

/** Bảng slot cho prompt: model thấy giá trị để lập luận nhưng phải viết tên slot */
const describeSlots = ({ slots, verdicts }, { scenarioType = null } = {}) => {
  const lines = ['=== [SLOT SỐ LIỆU - KHÔNG TỰ VIẾT CON SỐ; VIẾT TÊN SLOT, HỆ THỐNG TỰ ĐIỀN SỐ VÀ MÃ NGUỒN] ==='];
  for (const [key, s] of slots) {
    lines.push(`{{${key}}} = ${s.text} | ${s.desc}`);
  }
  if (scenarioType) {
    lines.push(`Trong phần này (kịch bản ${scenarioType}, ${PCT_OF[scenarioType]}) được viết gọn: ${QUANT_FIELDS.map(f => `{{${f}}}`).join(', ')} = các slot ${PCT_OF[scenarioType]} tương ứng.`);
  }
  lines.push('Slot đã gồm đơn vị (triệu/tháng, điểm, %, tin...) và mã [F#]: KHÔNG viết thêm đơn vị hay mã sau slot. Số âm đã có dấu trừ: không thêm chữ "âm".');
  const v = verdicts || {};
  const order = scenarioType ? [PCT_OF[scenarioType]] : ['P75', 'P50', 'P25'];
  const vl = order.filter(p => v[p]).map(p => `- ${p}: ${v[p]}`);
  if (vl.length) lines.push('KẾT LUẬN ĐÃ TÍNH SẴN (viết đúng theo kết luận này, không tự so sánh lại các con số):', ...vl);
  return lines.join('\n');
};

const listSlots = (text) => [...String(text || '').matchAll(SLOT_RE)].map(m => m[1]);

module.exports = { buildSlots, renderText, renderJson, describeSlots, resolveKey, listSlots, vn, SLOT_RE, PCT_OF, SCENARIO_KEY, QUANT_FIELDS };
