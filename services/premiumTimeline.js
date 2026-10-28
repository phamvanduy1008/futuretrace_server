/**
 * Khung thời gian của lộ trình premium: code chia, không để LLM tự chọn tháng.
 *
 * Bảo đảm:
 * - 5 giai đoạn (hoặc số mốc còn lại khi pivot) LIỀN NHAU, PHỦ ĐỦ từ tháng bắt đầu tới tháng cuối của khung, không chồng, không vượt.
 * - Nhãn gọn: "Tháng 3" (1 tháng), "Tháng 3-5" (nhiều tháng). Không bao giờ có "Tháng 1-1" hay "Tháng 5-3".
 * - Khung ngắn hơn số mốc (vd 3 tháng / 5 mốc) thì chia nhỏ tháng theo tuần: "Tháng 1 (tuần 1-2)".
 * - Mốc i dùng đúng nhãn giai đoạn i; tường thuật gồm đúng các đoạn "Nhãn: ...", mỗi giai đoạn một đoạn.
 */

const MAX_MONTHS = 120;
const toInt = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

const monthLabel = (a, b) => (a === b ? `Tháng ${a}` : `Tháng ${a}-${b}`);

/** Chia 4 tuần của một tháng thành p phần: p=2 -> [1-2],[3-4]; p=3 -> [1],[2-3],[4] */
const weekParts = (p) => {
  const cuts = Array.from({ length: p + 1 }, (_, i) => Math.round((4 * i) / p));
  return Array.from({ length: p }, (_, i) => [cuts[i] + 1, cuts[i + 1]]);
};

/**
 * @param {number} timeframe   tổng số tháng của lộ trình
 * @param {number} n           số giai đoạn (mặc định 5)
 * @param {number} startMonth  tháng bắt đầu (pivot: sau mốc đã hoàn thành cuối cùng)
 * @returns {{start:number,end:number,label:string}[]}
 */
const planPeriods = (timeframe = 12, n = 5, startMonth = 1) => {
  const T = Math.max(1, Math.min(MAX_MONTHS, toInt(timeframe, 12)));
  const S = Math.max(1, Math.min(T, toInt(startMonth, 1)));
  const span = T - S + 1;
  if (n <= 0) return [];

  if (span >= n) {
    // Lộ trình đầy đủ: giai đoạn đầu ngắn (khởi động), các giai đoạn sau dài dần; pivot: chia đều phần còn lại
    const q = n === 5 && S === 1 ? [0.15, 0.35, 0.6, 0.85] : Array.from({ length: n - 1 }, (_, i) => (i + 1) / n);
    const cuts = [];
    for (let i = 0; i < n - 1; i++) {
      const min = (cuts[i - 1] ?? 0) + 1;            // mỗi giai đoạn ít nhất 1 tháng
      const max = span - (n - 1 - i);               // chừa chỗ cho các giai đoạn sau
      cuts.push(Math.min(max, Math.max(min, Math.round(span * q[i]))));
    }
    const bounds = [0, ...cuts, span];
    return Array.from({ length: n }, (_, i) => {
      const a = S + bounds[i];
      const b = S + bounds[i + 1] - 1;
      return { start: a, end: b, label: monthLabel(a, b) };
    });
  }

  // Ít tháng hơn số mốc: chia nhỏ các tháng đầu theo tuần (tối đa 4 phần/tháng)
  const parts = Array(span).fill(1);
  let extra = Math.min(n, span * 4) - span;
  for (let i = 0; extra > 0; i = (i + 1) % span) {
    if (parts[i] < 4) { parts[i]++; extra--; }
  }
  const out = [];
  parts.forEach((p, i) => {
    const m = S + i;
    if (p === 1) out.push({ start: m, end: m, label: monthLabel(m, m) });
    else weekParts(p).forEach(([a, b]) => out.push({ start: m, end: m, label: `Tháng ${m} (tuần ${a === b ? a : `${a}-${b}`})` }));
  });
  while (out.length < n) out.push({ ...out[out.length - 1] }); // > 4 mốc/tháng: không xảy ra với khung 3-60 tháng
  return out;
};

/** "Tháng 3-5" -> {start:3,end:5}; "Tháng 1 (tuần 1-2)" -> {start:1,end:1}; không đọc được -> null */
const parseLabel = (label) => {
  const s = String(label || '').replace(/\([^)]*\)/g, ' ');
  const m = s.match(/tháng\s*(\d+)(?:\s*(?:[-–]|đến)\s*(?:tháng\s*)?(\d+))?/i);
  if (!m) return null;
  const a = toInt(m[1], 1);
  const b = m[2] ? toInt(m[2], a) : a;
  return { start: Math.min(a, b), end: Math.max(a, b) };
};

/** Sửa nhãn lỗi trong dữ liệu cũ: "Tháng 1-1" -> "Tháng 1"; "Tháng 5-3" -> "Tháng 3-5" (giữ phần "(tuần ...)") */
const tidyLabel = (label) => {
  const raw = String(label || '').trim();
  const p = parseLabel(raw);
  if (!p) return raw;
  const weeks = (raw.match(/\((tuần[^)]*)\)/i) || [])[1];
  return weeks ? `Tháng ${p.start} (${weeks})` : monthLabel(p.start, p.end);
};

// Mốc thời gian ở ĐẦU đoạn/câu: "Tháng 2-3: ...", "Tháng 4 (tuần 1-2): ...", "Trong tháng 5, ..."
const MARKER_RE = /(^|\n|[.!?…]\s+)((?:(?:giai đoạn|bắt đầu|cuối cùng,?|trong|từ|đến|sang|vào)\s+)*tháng\s*\d+(?:\s*(?:[-–]|đến)\s*(?:tháng\s*)?\d+)?(?:\s*\([^)]*\))?)\s*[:,.–-]?\s*/gi;

/**
 * Chia lại tường thuật theo đúng các giai đoạn: mỗi giai đoạn đúng 1 đoạn "Nhãn: nội dung".
 * Đoạn của model được gán vào giai đoạn chứa tháng mở đầu của nó; giai đoạn không có đoạn nào được viết bù từ sự kiện của mốc.
 */
const alignNarrative = (narrative, periods, milestones = []) => {
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const text = String(narrative || '').replace(/\r/g, '').trim();
  const marks = [];
  for (const m of text.matchAll(MARKER_RE)) {
    const at = m.index + m[1].length;
    marks.push({ at, end: m.index + m[0].length, range: parseLabel(m[2]) });
  }
  const intro = (marks.length ? text.slice(0, marks[0].at) : text).trim();
  const buckets = periods.map(() => []);
  const used = periods.map(() => 0);
  marks.forEach((mk, i) => {
    const body = text.slice(mk.end, marks[i + 1]?.at ?? text.length).trim();
    if (!body) return;
    const month = mk.range?.start ?? 1;
    // Giai đoạn chứa tháng đó (khung ngắn: nhiều giai đoạn cùng tháng -> lấp lần lượt)
    let idx = periods.findIndex((p, j) => p.start <= month && month <= p.end && used[j] === 0);
    if (idx < 0) idx = periods.findIndex(p => p.start <= month && month <= p.end);
    if (idx < 0) idx = month > (periods[periods.length - 1]?.end ?? 0) ? periods.length - 1 : 0;
    buckets[idx].push(cap(body));
    used[idx]++;
  });
  const paras = periods.map((p, i) => {
    let body = buckets[i].join(' ').replace(/\s{2,}/g, ' ').trim();
    if (!body) {
      const ev = String(milestones[i]?.event || '').trim().replace(/[.。]+$/, '');
      const evText = `${ev.charAt(0).toLowerCase()}${ev.slice(1)}`;
      if (!ev) body = 'Em củng cố kết quả giai đoạn trước và chuẩn bị cho bước tiếp theo.';
      else body = milestones[i]?.completed ? `Em đã hoàn thành mốc: ${evText}.` : `Em tập trung vào mục tiêu: ${evText}.`;
    }
    return `${p.label}: ${cap(body)}`;
  });
  // Không có mốc thời gian nào trong tường thuật: giữ nguyên văn làm phần mở đầu, rồi thêm các giai đoạn
  return [intro, ...paras].filter(Boolean).join('\n\n');
};

/**
 * Áp khung thời gian cho báo cáo premium (tạo mới hoặc pivot).
 * keep: số mốc đầu đã hoàn thành được giữ nguyên (pivot); các mốc mới chia phần thời gian còn lại.
 */
const applyTimeline = (report, timeframe = 12, { keep = 0 } = {}) => {
  if (!report || !Array.isArray(report.milestones)) return report;
  const T = Math.max(1, Math.min(MAX_MONTHS, toInt(timeframe, 12)));
  const total = report.milestones.length || 5;
  const k = Math.max(0, Math.min(total, keep));
  const kept = report.milestones.slice(0, k).map(m => ({ ...m, month: tidyLabel(m.month) }));
  const keptEnd = kept.reduce((mx, m) => Math.max(mx, Math.min(T, parseLabel(m.month)?.end ?? 0)), 0);
  const fresh = planPeriods(T, total - k, Math.min(T, keptEnd + 1));
  const milestones = [...kept, ...report.milestones.slice(k).map((m, j) => ({ ...m, month: fresh[j]?.label || m.month }))];
  const periods = [
    ...kept.map(m => ({ ...(parseLabel(m.month) || { start: 1, end: 1 }), label: m.month })),
    ...fresh
  ];
  return {
    ...report,
    milestones,
    detailedNarrative: alignNarrative(report.detailedNarrative, periods, milestones),
    timeframe: T
  };
};

/** Kiểm tra (cho test/đánh giá): các mốc liền nhau, phủ đủ 1..T, không vượt khung */
const coverage = (milestones, timeframe) => {
  const T = toInt(timeframe, 12);
  const ranges = (milestones || []).map(m => parseLabel(m?.month));
  if (ranges.some(r => !r)) return { ok: false, reason: 'nhãn không đọc được' };
  let next = 1;
  for (const r of ranges) {
    if (r.start > next) return { ok: false, reason: `thiếu tháng ${next}-${r.start - 1}` };
    if (r.end > T) return { ok: false, reason: `vượt khung (${r.end} > ${T})` };
    if (r.start < next - 1) return { ok: false, reason: `chồng lấn tại tháng ${r.start}` };
    next = Math.max(next, r.end + 1);
  }
  if (next - 1 < T) return { ok: false, reason: `chưa tới tháng ${T} (dừng ở tháng ${next - 1})` };
  return { ok: true };
};

module.exports = { planPeriods, parseLabel, tidyLabel, alignNarrative, applyTimeline, coverage, monthLabel };
