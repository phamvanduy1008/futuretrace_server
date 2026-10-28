/**
 * Bộ lọc mẫu huấn luyện v3 (viết theo phần + slot). Dùng chung cho: chuyển mẫu vàng, teacher sinh dữ liệu, đánh giá.
 *
 * Một phần đạt khi:
 *  - đủ trường đúng số lượng, độ dài từng trường trong khoảng cho phép;
 *  - KHÔNG có con số dữ liệu viết tay (số + triệu/%/điểm...): mọi số phải qua slot;
 *  - mọi slot có trong bảng của hồ sơ; số slot tối thiểu (summary >= 2 slot khác nhau, description >= 1,
 *    marketAnalysis >= 1 slot fact);
 *  - nhóm nghề gần đúng/yếu thì phần có lương phải có cụm "tham khảo"/"gần đúng";
 *  - không nêu tên trường ngoài hồ sơ; đủ tiếng Việt có dấu.
 */
const slotRenderer = require('../../services/slotRenderer');
const { verifyText, collectAllowed, CLAIM_RE } = require('../../services/groundingService');

const SCHOOL_MENTION = /(Đại học|ĐH|Học viện|Trường)\s+([A-ZĐÂĂÊÔƠƯ][\wÀ-ỹ]*(?:\s+[A-ZĐÂĂÊÔƠƯ][\wÀ-ỹ]*){0,5})/g;
const VI_CHARS = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/gi;
const HEDGE = /tham khảo|gần đúng|chưa (phản ánh|sát)|không (phản ánh|trùng)|nhóm nghề (tham chiếu|gần)|chỉ là mốc/i;

const wc = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
const stripSlots = (s) => String(s || '').replace(slotRenderer.SLOT_RE, ' ');

/** Các chuỗi văn bản của một phần, kèm tên trường để báo lỗi */
const fieldsOf = (section, json) => {
  if (section === 'overview') {
    return [['summary', json?.summary], ...['start', 'sixMonths', 'oneYear', 'threeYears'].map(k => [`timeline.${k}`, json?.timeline?.[k]])];
  }
  const out = [['title', json?.title], ['description', json?.description], ['criticalAdvice', json?.criticalAdvice], ['marketAnalysis', json?.marketAnalysis]];
  (json?.swot || []).forEach(x => out.push([`swot.${x?.type}`, x?.value]));
  (json?.sprint90 || []).forEach((ph, i) => { out.push([`sprint90[${i}].phase`, ph?.phase]); (ph?.tasks || []).forEach((t, j) => out.push([`sprint90[${i}].tasks[${j}]`, t])); });
  return out;
};

const structureError = (section, j) => {
  if (!j || typeof j !== 'object') return 'incomplete_fields: không phải JSON object';
  if (section === 'overview') {
    if (typeof j.summary !== 'string' || !j.timeline || ['start', 'sixMonths', 'oneYear', 'threeYears'].some(k => typeof j.timeline[k] !== 'string')) return 'incomplete_fields: cần summary và timeline 4 mốc';
    return null;
  }
  for (const k of ['title', 'description', 'criticalAdvice', 'marketAnalysis']) if (typeof j[k] !== 'string' || !j[k].trim()) return `incomplete_fields: thiếu ${k}`;
  if (!Array.isArray(j.swot) || j.swot.length !== 4 || j.swot.map(x => x?.type).join('') !== 'SWOT') return 'incomplete_fields: swot phải đúng 4 mục S, W, O, T';
  if (!Array.isArray(j.sprint90) || j.sprint90.length !== 3 || j.sprint90.some(ph => !Array.isArray(ph?.tasks) || ph.tasks.length !== 3)) return 'incomplete_fields: sprint90 phải 3 giai đoạn x 3 việc';
  return null;
};

const LENGTH_RULES = {
  overview: [['summary', 35, 100], ['timeline.', 18, 60]],
  scenario: [['title', 3, 25], ['description', 45, 120], ['criticalAdvice', 22, 70], ['marketAnalysis', 22, 70], ['swot.', 14, 50], ['tasks', 5, 30]]
};

/**
 * @param {string} section  'overview' | 'Positive' | 'Neutral' | 'Risk'
 * @param {object} json     đầu ra của model cho phần đó (còn slot, chưa điền)
 * @param {object} prep     simulationRunner.prepare(input)
 * @returns {string|null}   lý do loại (kèm chi tiết sau dấu ":"), null nếu đạt
 */
const checkSection = (section, json, prep) => {
  const s = structureError(section, json);
  if (s) return s;
  const fields = fieldsOf(section, json);
  const scenarioType = section === 'overview' ? null : section;

  // Độ dài
  for (const [name, text] of fields) {
    if (name.endsWith('.phase')) continue;
    const rule = LENGTH_RULES[section === 'overview' ? 'overview' : 'scenario'].find(([k]) => name === k || name.startsWith(k) || name.includes(k));
    if (!rule) continue;
    const n = wc(stripSlots(text)) + (String(text).match(slotRenderer.SLOT_RE) || []).length * 2; // slot ~ 2 từ khi điền
    if (n < rule[1] || n > rule[2]) return `bad_length: ${name} có ${n} từ (cần ${rule[1]}-${rule[2]})`;
  }

  // Số viết tay (không qua slot). Ngoại lệ: mốc phân vị định nghĩa kịch bản ("nhóm 25% tốt nhất") do chính prompt đặt ra
  const DEFINITIONAL = /^(25|50|75)\s*%$/;
  for (const [name, text] of fields) {
    const raw = [...stripSlots(text).matchAll(CLAIM_RE)].map(m => m[0]).filter(x => !DEFINITIONAL.test(x.trim()));
    if (raw.length) return `raw_number: ${name} tự viết số "${raw[0]}" (phải dùng slot)`;
    if (/\[F\d+\]/.test(stripSlots(String(text).replace(/\{\{[^}]*\}\}\s*\[F\d+\]/g, ' ')))) return `raw_citation: ${name} tự viết mã [F#] ngoài slot`;
  }


  // Mâu thuẫn với kết luận tài chính đã tính sẵn
  const scen = prep.quant?.scenarios?.[scenarioType || 'Neutral'];
  if (scen?.affordability) {
    const all = fields.map(([, t]) => t).join(' ').toLowerCase();
    const saysShort = /không đủ (khả năng|tiền)|vượt (quá )?khả năng|thiếu \{\{|áp lực tài chính (lớn|nặng)|gánh nặng tài chính lớn/.test(all);
    if (scen.affordability.affordable && saysShort) return 'contradiction: gia đình ĐỦ khả năng chi trả nhưng văn bản nói thiếu tiền/áp lực tài chính lớn';
    if (!scen.affordability.affordable && /(?<!không )đủ khả năng chi trả/.test(all)) return 'contradiction: gia đình KHÔNG ĐỦ khả năng chi trả nhưng văn bản nói đủ';
  }

  // Slot hợp lệ + số tối thiểu
  const unknown = [];
  const used = new Set();
  for (const [, text] of fields) {
    for (const key of slotRenderer.listSlots(text)) {
      const full = slotRenderer.resolveKey(key, scenarioType);
      if (!prep.slotCtx.slots.has(full)) unknown.push(key);
      else used.add(full);
    }
  }
  if (unknown.length) return `unknown_slot: {{${unknown[0]}}} không có trong bảng slot`;
  const factSlots = [...prep.slotCtx.slots.keys()].filter(k => /^F\d+/.test(k));
  if (section === 'overview') {
    const inSummary = new Set(slotRenderer.listSlots(json.summary).map(k => slotRenderer.resolveKey(k, null)));
    if (prep.slotCtx.slots.size >= 3 && inSummary.size < 2) return 'few_slots: summary cần ít nhất 2 slot khác nhau';
  } else {
    if (prep.slotCtx.slots.size && !slotRenderer.listSlots(json.description).length) return 'few_slots: description cần ít nhất 1 slot số liệu của kịch bản';
    if (factSlots.length && !slotRenderer.listSlots(json.marketAnalysis).some(k => /^F\d+/.test(k))) return 'few_slots: marketAnalysis cần ít nhất 1 slot fact {{F#}}';
  }

  // Sau khi điền: mọi số phải có căn cứ (lớp an toàn thứ hai)
  const rendered = slotRenderer.renderJson(json, prep.slotCtx, scenarioType).json;
  const allowed = collectAllowed({ facts: prep.factSheet.facts, quant: prep.quant, input: prep.cleanData });
  for (const [name, text] of fieldsOf(section, rendered)) {
    const v = verifyText(text, allowed);
    if (v.removed.length) return `ungrounded_number: ${name}`;
  }

  // Nhóm nghề gần đúng: phần có nói về lương/tin tuyển phải ghi rõ mốc tham khảo
  const allText = fields.map(([, t]) => t).join(' ');
  if (prep.hedge) {
    const salaryFacts = (prep.factSheet.facts || []).filter(f => /^salary|^demand/.test(f.kind || '')).map(f => f.id);
    const mentionsSalary = [...used].some(k => salaryFacts.includes(k.split('.')[0]));
    if (mentionsSalary && !HEDGE.test(allText)) return 'missing_hedge: nhóm nghề gần đúng nhưng chưa nói rõ là mốc tham khảo';
  }

  // Tên trường lạ
  const known = `${prep.factSheet.school?.name || ''} ${prep.cleanData.decision}`.toLowerCase();
  for (const [, text] of fields) {
    for (const m of String(text).matchAll(SCHOOL_MENTION)) {
      if (!known.includes(m[2].toLowerCase().split(' ').slice(0, 2).join(' '))) return `unknown_entity: ${m[0]}`;
    }
  }
  if ((allText.match(VI_CHARS) || []).length / Math.max(allText.length, 1) < 0.08) return 'not_vietnamese';
  return null;
};

module.exports = { checkSection, fieldsOf, wc, HEDGE };
