/**
 * Chuyển mẫu vàng (JSON đầy đủ, số viết tay) sang dữ liệu huấn luyện v3: 4 phần, số liệu thay bằng slot.
 *
 *   node ml/finetune/gold_to_slots.js        -> data/gold/sections.jsonl + báo cáo tỷ lệ chuyển
 *
 * Mỗi cụm "số + đơn vị [+ [F#]]" trong văn bản được ánh xạ về slot có cùng giá trị và cùng loại đơn vị;
 * ưu tiên mã [F#] đi kèm, rồi slot của chính kịch bản đang viết. Cụm không ánh xạ được -> bỏ phần đó (không đoán).
 * Kiểm tra lại: điền slot phải ra đúng các số ban đầu, và phần phải qua checkSection.
 */
const fs = require('fs');
const path = require('path');

const quiet = console.log;
console.log = () => {};
const runner = require('../../services/simulationRunner');
const slotRenderer = require('../../services/slotRenderer');
const task = require('../../services/prompts/simulationTask');
const { checkSection, fieldsOf } = require('./sectionCheck');
console.log = quiet;

const GOLD = path.join(__dirname, '../../data/gold/gold_samples.jsonl');
const OUT = path.join(__dirname, '../../data/gold/sections.jsonl');

const NUM = '(-?\\d+(?:[.,]\\d+)?)';
// "12,4 triệu/tháng [F2]", "10-15 triệu [F2]", "-53%", "1,9%/năm", "24,15 điểm", "17685 tin", "năm thứ 9"
const CLAIM = new RegExp(`${NUM}(?:\\s*-\\s*${NUM})?\\s*(triệu\\s*/\\s*tháng|triệu\\s*/\\s*năm|triệu đồng|triệu VNĐ|triệu|tr\\s*/\\s*tháng|tr\\b|%\\s*/\\s*năm|%|điểm|tin)(\\s*\\[F(\\d+)\\])?`, 'giu');
const PAYBACK = /năm thứ (\d+)/g;
const num = (s) => Number(String(s).replace(',', '.'));
const same = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 0.051;

const unitClass = (u) => {
  u = u.replace(/\s+/g, '');
  if (/^(triệu\/tháng|tr\/tháng)$/.test(u)) return 'month';
  if (u === 'triệu/năm') return 'year';
  if (/^(triệu|tr|triệuđồng|triệuVNĐ)$/.test(u)) return 'money';
  if (u === '%/năm') return 'growth';
  if (u === '%') return 'pct';
  if (u === 'điểm') return 'score';
  if (u === 'tin') return 'count';
  return null;
};
const factClass = (f) => ({ 'triệu/tháng': 'month', 'điểm/30': 'score', tin: 'count', '%': 'pct', 'triệu VNĐ': 'money' }[f.unit] || null);

/** Ứng viên slot: [key, value, class, range?] */
const candidates = (prep) => {
  const out = [];
  for (const f of prep.factSheet.facts || []) {
    if (typeof f.value !== 'number') continue;
    out.push({ key: f.id, value: f.value, cls: factClass(f), fact: f.id });
    if (Array.isArray(f.range)) {
      out.push({ key: `${f.id}.range`, range: f.range, cls: factClass(f), fact: f.id });
      out.push({ key: `${f.id}.low`, value: f.range[0], cls: factClass(f), fact: f.id, bound: true });
      out.push({ key: `${f.id}.high`, value: f.range[1], cls: factClass(f), fact: f.id, bound: true });
    }
  }
  for (const [pct, type] of Object.entries(slotRenderer.SCENARIO_KEY)) {
    const s = prep.quant?.scenarios?.[type];
    if (!s) continue;
    out.push({ key: `${pct}.start`, value: s.salary?.startMonthlyMillion, cls: 'month', pct });
    out.push({ key: `${pct}.year5`, value: s.salary?.year5MonthlyMillion, cls: 'month', pct });
    if (s.roi) out.push({ key: `${pct}.roi`, value: Math.round(s.roi.ratio * 100), cls: 'pct', pct });
    const a = s.affordability;
    if (a) {
      out.push({ key: `${pct}.cash`, value: a.cashNeedPerYearMillion, cls: 'year', pct });
      out.push({ key: `${pct}.family`, value: a.familyCapacityPerYearMillion, cls: 'year', pct });
      if (prep.slotCtx.slots.has(`${pct}.gap`)) out.push({ key: `${pct}.gap`, value: a.gapPerYearMillion, cls: 'year', pct });
    }
  }
  const g = prep.quant?.market?.salaryGrowthPercentPerYear;
  if (typeof g === 'number') out.push({ key: 'growth', value: g, cls: 'growth' });
  if (typeof prep.cleanData?.expectedScore === 'number') out.push({ key: 'score', value: prep.cleanData.expectedScore, cls: 'score' });
  return out.filter(c => prep.slotCtx.slots.has(c.key));
};

const pctOf = (section) => slotRenderer.PCT_OF[section] || null;

/** Viết slot: rút gọn {{start}} nếu là slot của chính kịch bản đang viết */
const slotToken = (key, section) => {
  const p = pctOf(section);
  if (p && key.startsWith(`${p}.`)) return `{{${key.slice(p.length + 1)}}}`;
  return `{{${key}}}`;
};

/** Chuyển một chuỗi; trả về null nếu có cụm số không ánh xạ được */
const convertText = (text, prep, cands, section) => {
  let failed = null;
  const p = pctOf(section);
  let out = text.replace(CLAIM, (m, a, b, unit, cite, fid) => {
    if (failed) return m;
    let cls = unitClass(unit);
    const isRange = b !== undefined;
    const va = num(a);
    const vb = isRange ? num(b) : null;
    const match = (c) => {
      if (isRange) return Array.isArray(c.range) && same(c.range[0], va) && same(c.range[1], vb);
      return !c.range && same(c.value, va);
    };
    let pool = cands.filter(match);
    // Đơn vị: "triệu" trơn khớp mọi loại tiền; "%" có thể là ROI, xác suất hoặc tăng lương
    pool = pool.filter(c => c.cls === cls || (cls === 'money' && ['month', 'year', 'money'].includes(c.cls)) || (cls === 'pct' && ['pct', 'growth'].includes(c.cls)) || (cls === 'growth' && c.cls === 'growth'));
    if (fid) {
      const byFact = pool.find(c => c.fact === `F${fid}`);
      if (byFact) return slotToken(byFact.key, section);
      pool = pool.filter(c => !c.fact); // mã [F#] sai: thử quant nhưng bỏ mã
    }
    const rank = (c) => (p && c.pct === p ? 0 : c.pct === 'P50' ? 1 : c.pct ? 2 : c.fact ? 3 : 4);
    pool.sort((x, y) => rank(x) - rank(y));
    if (!pool.length) { failed = m; return m; }
    // "%/năm" của tăng lương: slot đã có "%/năm"
    return slotToken(pool[0].key, section) + (fid && !pool[0].fact ? '' : '');
  });
  if (failed) return { text: null, failed };
  // Số ngay trước mã nguồn nhưng không có đơn vị: "trải 15,1-28,89 [F1]", "16 [F1]"
  out = out.replace(new RegExp(`${NUM}(?:\\s*-\\s*${NUM})?\\s*\\[F(\\d+)\\]`, 'gu'), (m, a, b, fid) => {
    const c = cands.find(x => x.fact === `F${fid}` && (b !== undefined
      ? Array.isArray(x.range) && same(x.range[0], num(a)) && same(x.range[1], num(b))
      : !x.range && same(x.value, num(a))));
    if (c) return slotToken(c.key, section);
    if (b === undefined && /^(19|20)\d\d$/.test(a)) return a; // năm (vd "năm 2025 [F1]"): giữ số, bỏ mã
    if (!failed) failed = m;
    return m;
  });
  if (failed) return { text: null, failed };
  // Khoảng không đơn vị "24,01-28,25" trùng khoảng của fact -> {{F#.range}}
  out = out.replace(/(?<![\d{.,])(\d+(?:,\d+)?)\s*-\s*(\d+(?:,\d+)?)(?![\d}])/g, (m, a, b) => {
    const c = cands.find(x => Array.isArray(x.range) && same(x.range[0], num(a)) && same(x.range[1], num(b)));
    return c ? slotToken(c.key, section) : m;
  });
  // Số thập phân trơn (vd "trung vị 22,5 trên 38 chương trình") trùng đúng một giá trị fact/định lượng -> slot
  out = out.replace(/(?<![\d{.,])(\d+,\d+)(?![\d}])/g, (m, a) => {
    const pool = cands.filter(c => !c.range && same(c.value, num(a)));
    const keys = [...new Set(pool.map(c => c.key))];
    if (!keys.length) return m;
    const rank = (k) => (p && k.startsWith(`${p}.`) ? 0 : k.startsWith('P50.') ? 1 : /^F/.test(k) ? 2 : 3);
    keys.sort((x, y) => rank(x) - rank(y));
    return slotToken(keys[0], section);
  });
  // Mã [F#] còn lại đứng riêng: slot đã mang mã nguồn nên bỏ (giữ thì model học viết mã ngoài slot)
  out = out.replace(/(\{\{[^}]+\}\})?(\s*)\[F\d+\]/g, (m, slot, sp) => (slot ? m : '')).replace(/\s+([,.;:)])/g, '$1').replace(/\s{2,}/g, ' ');
  // "năm thứ N" -> {{payback}} của kịch bản (hoặc P50 ở phần tổng quan)
  out = out.replace(PAYBACK, (m, n) => {
    const order = p ? [p, 'P50', 'P75', 'P25'] : ['P50', 'P75', 'P25'];
    for (const q of order) {
      const s = prep.quant?.scenarios?.[slotRenderer.SCENARIO_KEY[q]];
      if (s?.roi?.paybackYearFromNow === Number(n)) return slotToken(`${q}.payback`, section);
    }
    return m;
  });
  return { text: out, failed: null };
};

const convertSection = (obj, prep, section) => {
  const cands = candidates(prep);
  let failed = null;
  const walk = (v, key) => {
    if (failed) return v;
    if (typeof v === 'string') {
      if (key === 'type' || key === 'phase') return v;
      const r = convertText(v, prep, cands, section);
      if (!r.text) { failed = r.failed; return v; }
      return r.text;
    }
    if (Array.isArray(v)) return v.map(x => walk(x, key));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  const json = walk(obj, null);
  return { json, failed };
};

const main = () => {
  const gold = fs.readFileSync(GOLD, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const rows = [];
  const stats = { profiles: gold.length, sections: 0, ok: 0, reasons: {} };
  const bump = (r) => { const k = r.split(':')[0]; stats.reasons[k] = (stats.reasons[k] || 0) + 1; };
  for (const g of gold) {
    const prep = runner.prepare(g.input);
    const full = JSON.parse(g.messages[2].content);
    const parts = {
      overview: { summary: full.summary, timeline: full.timeline },
      ...Object.fromEntries((full.scenarios || []).map(s => {
        const { type, ...rest } = s;
        return [type, rest];
      }))
    };
    for (const section of task.SECTIONS) {
      stats.sections++;
      if (!parts[section]) { bump('missing_section'); continue; }
      const conv = convertSection(parts[section], prep, section);
      if (conv.failed) { bump(`unmapped_number`); continue; }
      const reason = checkSection(section, conv.json, prep);
      if (reason) { bump(reason); continue; }
      // Điền lại slot phải ra đúng các số của mẫu gốc (so tập số liệu trong văn bản)
      const back = slotRenderer.renderJson(conv.json, prep.slotCtx, section === 'overview' ? null : section).json;
      // So các số mang dữ liệu (số + đơn vị, khoảng, số thập phân, "năm thứ N"), bỏ mã [F#] và chữ số trong mã
      const nums = (o) => fieldsOf(section, o).map(([, t]) => (String(t).replace(/\[F\d+\]/g, ' ').match(/\d+(?:,\d+)?/g) || []).map(x => Math.round(num(x) * 100)).sort((x, y) => x - y).join(',')).join('|');
      if (nums(back) !== nums(parts[section])) { bump('roundtrip_mismatch'); continue; }
      stats.ok++;
      rows.push({
        id: `${g.id}:${section}`, source: g.id, section, stage: g.stage, input: g.input,
        messages: [
          { role: 'system', content: prep.sectionSystem },
          { role: 'user', content: prep.sections[section] },
          { role: 'assistant', content: JSON.stringify(conv.json) }
        ]
      });
    }
  }
  fs.writeFileSync(OUT, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  quiet(`Chuyển ${stats.ok}/${stats.sections} phần (${stats.profiles} mẫu vàng) -> ${OUT}`);
  quiet('Lý do bỏ:', JSON.stringify(stats.reasons));
};

if (require.main === module) main();
module.exports = { convertSection, candidates };
