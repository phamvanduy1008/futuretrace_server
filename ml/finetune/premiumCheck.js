/**
 * Bộ lọc mẫu huấn luyện premium v3 (khung + 5 mốc chi tiết). Dùng cho teacher, đánh giá và (một phần) production.
 * Đạt khi: đủ cấu trúc; độ dài trong khoảng; mốc tăng dần trong khung thời gian; không tự viết số liệu thị trường
 * (chỉ câu có từ khóa dữ liệu mới bị coi là số liệu); slot hợp lệ; sau khi điền thì số có căn cứ; có hedge khi
 * nhóm nghề gần đúng và có nhắc lương/tin; không tên trường lạ; không đường link; tiếng Việt có dấu.
 */
const slotRenderer = require('../../services/slotRenderer');
const { parseLabel } = require('../../services/premiumTimeline');
const { verifyDataText, collectAllowed, CLAIM_RE, DATA_KEYWORDS } = require('../../services/groundingService');

const SCHOOL_MENTION = /(Đại học|ĐH|Học viện|Trường)\s+([A-ZĐÂĂÊÔƠƯ][\wÀ-ỹ]*(?:\s+[A-ZĐÂĂÊÔƠƯ][\wÀ-ỹ]*){0,5})/g;
const VI_CHARS = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/gi;
const HEDGE = /tham khảo|gần đúng|chưa (phản ánh|sát)|không (phản ánh|trùng)|nhóm nghề (tham chiếu|gần)|chỉ là mốc/i;
const URL_RE = /https?:\/\/|www\./i;
const SELF_TITLE = /\b(chị|anh|tôi|mình) (là|sẽ|xin|muốn|nghĩ)|^(chào|xin chào)/i;
const IMPACT = ['High', 'Medium', 'Low'];

const wc = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
const slotWords = (s) => wc(String(s || '').replace(slotRenderer.SLOT_RE, ' ')) + (String(s || '').match(slotRenderer.SLOT_RE) || []).length * 2;

/** Các tháng trong nhãn "Tháng 3", "Tháng 4-6", "Tháng 1 (tuần 3-4)" -> [3] / [4, 6] / [1] (bỏ phần tuần trong ngoặc) */
const monthsOf = (label) => {
  const r = parseLabel(label);
  return r ? (r.start === r.end ? [r.start] : [r.start, r.end]) : [];
};

const textsOf = (section, j) => {
  if (section === 'plan') {
    return [
      ['detailedNarrative', j.detailedNarrative], ['longTermProjection', j.longTermProjection],
      ...(j.milestones || []).map((m, i) => [`milestones[${i}].event`, m?.event]),
      ...(j.influencingFactors || []).flatMap((f, i) => [[`factors[${i}].factor`, f?.factor], [`factors[${i}].description`, f?.description]]),
      ...(j.strategicPivotPoints || []).flatMap((p, i) => [[`pivots[${i}].condition`, p?.condition], [`pivots[${i}].action`, p?.action]])
    ];
  }
  return (j.details || []).flatMap((d, i) => [
    [`step${i + 1}.title`, d?.title], [`step${i + 1}.description`, d?.description], [`step${i + 1}.expectedResult`, d?.expectedResult],
    ...(d?.objectives || []).map((x, k) => [`step${i + 1}.objectives[${k}]`, x]),
    ...(d?.actions || []).map((x, k) => [`step${i + 1}.actions[${k}]`, x]),
    ...(d?.tools || []).map((x, k) => [`step${i + 1}.tools[${k}]`, x])
  ]);
};

const lengthRules = (section) => (section === 'plan'
  ? [['detailedNarrative', 150, 420], ['longTermProjection', 40, 130], ['.event', 6, 25], ['.factor', 1, 12], ['.description', 15, 55], ['.condition', 6, 35], ['.action', 12, 50]]
  : [['.title', 4, 18], ['.description', 25, 85], ['.expectedResult', 10, 45], ['.objectives', 5, 30], ['.actions', 10, 45], ['.tools', 1, 16]]);

/**
 * @param {'plan'|'milestone'} section
 * @param {object} json      đầu ra model cho phần đó (còn slot)
 * @param {object} prep      simulationRunner.prepare(context)
 * @param {object} opts      { timeframe, plan (khi section = milestone) }
 * @returns {string|null}    lý do loại hoặc null nếu đạt
 */
const checkPremiumSection = (section, json, prep, { timeframe = 12 } = {}) => {
  if (!json || typeof json !== 'object') return 'incomplete_fields: không phải JSON object';
  if (section === 'plan') {
    if (typeof json.detailedNarrative !== 'string' || typeof json.longTermProjection !== 'string') return 'incomplete_fields: thiếu tường thuật hoặc tầm nhìn';
    if (!Array.isArray(json.milestones) || json.milestones.length !== 5) return 'incomplete_fields: cần đúng 5 mốc';
    if (!Array.isArray(json.influencingFactors) || json.influencingFactors.length !== 4) return 'incomplete_fields: cần đúng 4 yếu tố';
    if (!Array.isArray(json.strategicPivotPoints) || json.strategicPivotPoints.length !== 3) return 'incomplete_fields: cần đúng 3 điểm rẽ nhánh';
    // Thời gian: mỗi mốc có tháng, tăng dần (không lùi), không vượt khung
    let last = 0;
    for (const [i, m] of json.milestones.entries()) {
      const ms = monthsOf(m?.month);
      if (!ms.length || !/tháng/i.test(m?.month || '')) return `bad_timeline: mốc ${i + 1} thiếu "Tháng ..."`;
      if (ms[0] < last) return `bad_timeline: mốc ${i + 1} (${m.month}) lùi về trước mốc trước`;
      if (Math.max(...ms) > timeframe) return `bad_timeline: mốc ${i + 1} (${m.month}) vượt khung ${timeframe} tháng`;
      last = Math.max(...ms);
      if (!IMPACT.includes(m.impact)) return `incomplete_fields: impact mốc ${i + 1}`;
      if (!Number.isInteger(m.probability) || m.probability < 0 || m.probability > 100) return `incomplete_fields: probability mốc ${i + 1}`;
    }
    if ((json.detailedNarrative.match(/tháng\s*\d+/gi) || []).length < 3) return 'bad_length: detailedNarrative cần ít nhất 3 đoạn mở đầu "Tháng ..."';
    if (!json.strategicPivotPoints.every(p => /^nếu\b/i.test(String(p?.condition || '').trim()))) return 'bad_format: condition phải bắt đầu bằng "Nếu"';
  } else {
    if (!Array.isArray(json.details) || json.details.length !== 3) return 'incomplete_fields: cần đúng 3 bước';
    for (const [i, d] of json.details.entries()) {
      for (const k of ['objectives', 'actions', 'tools']) {
        if (!Array.isArray(d?.[k]) || d[k].length < 2 || d[k].length > 3) return `incomplete_fields: bước ${i + 1} cần 2-3 ${k}`;
      }
      for (const k of ['title', 'description', 'expectedResult']) if (typeof d?.[k] !== 'string' || !d[k].trim()) return `incomplete_fields: bước ${i + 1} thiếu ${k}`;
    }
  }

  const fields = textsOf(section, json);
  for (const [name, text] of fields) {
    const rule = lengthRules(section).find(([k]) => name === k || name.endsWith(k) || name.includes(`${k}[`));
    if (rule) {
      const n = slotWords(text);
      if (n < rule[1] || n > rule[2]) return `bad_length: ${name} có ${n} từ (cần ${rule[1]}-${rule[2]})`;
    }
    if (URL_RE.test(String(text))) return `url: ${name} có đường link`;
    if (SELF_TITLE.test(String(text).trim())) return `self_title: ${name} tự xưng hoặc chào hỏi`;
    // Số liệu thị trường viết tay (câu có từ khóa dữ liệu + số có đơn vị) phải đi qua slot
    const plain = String(text).replace(slotRenderer.SLOT_RE, ' ');
    for (const sent of plain.split(/(?<=[.!?…])\s+/)) {
      if (DATA_KEYWORDS.test(sent)) {
        const raw = [...sent.matchAll(CLAIM_RE)].map(m => m[0]).filter(x => !/^(25|50|75)\s*%$/.test(x.trim()));
        if (raw.length) return `raw_number: ${name} tự viết số liệu "${raw[0]}" (phải dùng slot)`;
      }
    }
  }

  // Slot hợp lệ; sau khi điền thì số liệu có căn cứ
  for (const [name, text] of fields) {
    for (const key of slotRenderer.listSlots(text)) {
      if (!prep.slotCtx.slots.has(slotRenderer.resolveKey(key, null))) return `unknown_slot: {{${key}}} trong ${name} không có trong bảng slot`;
    }
  }
  const rendered = slotRenderer.renderJson(json, prep.slotCtx).json;
  const allowed = collectAllowed({ facts: prep.factSheet.facts, quant: prep.quant, input: prep.cleanData });
  for (const [name, text] of textsOf(section, rendered)) {
    if (verifyDataText(text, allowed).removed.length) return `ungrounded_number: ${name}`;
  }

  const allText = fields.map(([, t]) => t).join(' ');
  if (prep.hedge) {
    const salaryFacts = (prep.factSheet.facts || []).filter(f => /^salary|^demand/.test(f.kind || '')).map(f => f.id);
    const usesSalary = slotRenderer.listSlots(allText).some(k => salaryFacts.includes(k.split('.')[0]));
    if (usesSalary && !HEDGE.test(allText)) return 'missing_hedge: nhóm nghề gần đúng nhưng chưa nói rõ là mốc tham khảo';
  }
  const known = `${prep.factSheet.school?.name || ''} ${prep.cleanData.decision}`.toLowerCase();
  for (const [name, text] of fields) {
    for (const m of String(text).matchAll(SCHOOL_MENTION)) {
      // "Trường ĐH Kinh Tế ĐN" = "Đại học Kinh Tế - Đại học Đà Nẵng": bỏ tiền tố ĐH/Đại học rồi so 2 từ đầu
      const core = m[2].replace(/^(ĐH|Đại học)\s+/i, '').toLowerCase().split(/\s+/).slice(0, 2).join(' ');
      if (core && !known.includes(core)) return `unknown_entity: ${name} nêu "${m[0]}"`;
    }
  }
  if ((allText.match(VI_CHARS) || []).length / Math.max(allText.length, 1) < 0.08) return 'not_vietnamese';
  return null;
};

module.exports = { checkPremiumSection, monthsOf, textsOf };
