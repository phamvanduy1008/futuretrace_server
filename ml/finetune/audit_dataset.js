/**
 * Kiểm toán bộ dữ liệu SFT sau khi sinh, và tạo 2 file duyệt tay cho 2 thành viên.
 *   node ml/finetune/audit_dataset.js --dir data/sft_t1 [--review 200]
 * Xuất: audit_report.json (thống kê), review_A.csv và review_B.csv (mỗi file một nửa số mẫu duyệt, phân tầng).
 * Người duyệt ghi mã mẫu sai vào <dir>/bad_ids.txt (mỗi dòng một id); build_sft_dataset.js tự loại khi tách train/val.
 */
const fs = require('fs');
const path = require('path');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []));
const DIR = path.resolve(args.dir || path.join(__dirname, '../../data/sft_t1'));
const N_REVIEW = Number(args.review || 200);

const rows = fs.readFileSync(path.join(DIR, 'samples.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const bad = new Set(fs.existsSync(path.join(DIR, 'bad_ids.txt')) ? fs.readFileSync(path.join(DIR, 'bad_ids.txt'), 'utf8').split(/\s+/).filter(Boolean) : []);

const meta = (r) => {
  const user = r.messages[1].content;
  const out = JSON.parse(r.messages[2].content);
  const stage = (user.match(/- Giai đoạn: ([^|\n]+)/) || [])[1]?.trim() || '?';
  const fit = /chỉ mang tính tham khảo/.test(user) ? 'weak' : /tham chiếu gần đúng/.test(user) ? 'approx' : /Lương rao tuyển/.test(user) ? 'strong' : 'no_salary';
  const industry = (user.match(/ngành "([^"]+)"/) || [])[1] || '?';
  const decision = (user.match(/quyết định: (.+)/) || [])[1] || '';
  const words = (s) => String(s || '').split(/\s+/).filter(Boolean);
  const text = [out.summary, ...out.scenarios.flatMap(s => [s.description, s.criticalAdvice, s.marketAnalysis])].join(' ');
  return { id: r.id, stage, fit, industry, decision, out, nWords: words(text).length };
};
const ms = rows.map(meta);

// Trùng lặp gần: Jaccard trên tập 4-gram từ của phần mô tả kịch bản Neutral
const shingles = (s) => { const w = s.toLowerCase().split(/\s+/); const set = new Set(); for (let i = 0; i + 4 <= w.length; i++) set.add(w.slice(i, i + 4).join(' ')); return set; };
const sets = ms.map(m => shingles(m.out.scenarios[1].description + ' ' + m.out.summary));
let dup = 0;
const dupIds = new Set();
for (let i = 0; i < sets.length; i++) {
  for (let j = i + 1; j < sets.length; j++) {
    let inter = 0;
    for (const x of sets[i]) if (sets[j].has(x)) inter++;
    const jac = inter / (sets[i].size + sets[j].size - inter || 1);
    if (jac > 0.5) { dup++; dupIds.add(ms[j].id); }
  }
}

const count = (key) => ms.reduce((a, m) => ((a[m[key]] = (a[m[key]] || 0) + 1), a), {});
const report = {
  samples: ms.length,
  marked_bad: [...bad].filter(id => ms.some(m => m.id === id)).length,
  usable_after_bad: ms.filter(m => !bad.has(m.id) && !dupIds.has(m.id)).length,
  near_duplicate_pairs: dup,
  near_duplicate_samples: dupIds.size,
  by_stage: count('stage'),
  by_fit: count('fit'),
  top_industries: Object.entries(count('industry')).sort((a, b) => b[1] - a[1]).slice(0, 12),
  avg_words: Math.round(ms.reduce((a, m) => a + m.nWords, 0) / Math.max(ms.length, 1)),
  notes: [
    'near_duplicate_samples nên < 5%: nhiều hơn nghĩa là teacher lặp mẫu, tăng temperature hoặc đa dạng hóa few-shot',
    'by_fit: weak+approx nên chiếm 50-60% (thiết kế 55%) để mô hình học cách nói rõ mốc tham khảo; thấp hơn thì bổ sung hồ sơ'
  ]
};
fs.writeFileSync(path.join(DIR, 'audit_report.json'), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(DIR, 'dup_ids.txt'), [...dupIds].join('\n') + '\n'); // build_sft_dataset.js tự loại các mẫu trùng này

// Chọn mẫu duyệt: phân tầng theo (giai đoạn, mức khớp), xen kẽ; bỏ mẫu đã đánh dấu sai/trùng
const pool = ms.filter(m => !bad.has(m.id) && !dupIds.has(m.id));
const buckets = {};
for (const m of pool) (buckets[`${m.stage}|${m.fit}`] ||= []).push(m);
const picked = [];
for (let r = 0; picked.length < N_REVIEW; r++) {
  let any = false;
  for (const k of Object.keys(buckets)) if (buckets[k][r] && picked.length < N_REVIEW) { picked.push(buckets[k][r]); any = true; }
  if (!any) break;
}
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
const header = ['id', 'giai_doan', 'muc_khop_nghe', 'hoso', 'tom_tat', 'kich_ban_Positive', 'kich_ban_Neutral', 'kich_ban_Risk', 'loi_khuyen_Neutral', 'sprint_Neutral',
  'dung_kien_thuc_nganh (1/0)', 'giong_van_phu_hop_hoc_sinh (1/0)', 'khong_hua_hen_qua_muc (1/0)', 'noi_ro_muc_tham_khao_neu_can (1/0)', 'quyet_dinh (OK/BAD)', 'ly_do'];
const line = (m) => {
  const s = m.out.scenarios;
  return [m.id, m.stage, m.fit, m.decision, m.out.summary, s[0].description, s[1].description, s[2].description, s[1].criticalAdvice,
    s[1].sprint90.map(p => `${p.phase}: ${p.tasks.join('; ')}`).join(' | '), '', '', '', '', '', ''].map(csvCell).join(',');
};
for (const [name, part] of [['A', picked.filter((_, i) => i % 2 === 0)], ['B', picked.filter((_, i) => i % 2 === 1)]]) {
  fs.writeFileSync(path.join(DIR, `review_${name}.csv`), '﻿' + [header.map(csvCell).join(','), ...part.map(line)].join('\n'));
}
console.log(JSON.stringify(report, null, 2));
console.log(`Đã xuất review_A.csv (${Math.ceil(picked.length / 2)} mẫu) và review_B.csv (${Math.floor(picked.length / 2)} mẫu) trong ${DIR}`);
