/**
 * In gọn K hồ sơ tiếp theo chưa có mẫu trong data/gold/out (để người viết mẫu đọc).
 *   node ml/finetune/show_batch.js 8
 */
const fs = require('fs');
const path = require('path');
const P = path.join(__dirname, '../../data/gold/prompts');
const O = path.join(__dirname, '../../data/gold/out');
const k = Number(process.argv[2] || 8);
const done = new Set(fs.existsSync(O) ? fs.readdirSync(O).map(f => f.replace('.json', '')) : []);
const ids = fs.readdirSync(P).filter(f => f.endsWith('.txt')).map(f => f.replace('.txt', '')).filter(id => !done.has(id)).sort();
console.log(`# còn ${ids.length} hồ sơ chưa viết; in ${Math.min(k, ids.length)} hồ sơ`);
for (const id of ids.slice(0, k)) {
  const t = fs.readFileSync(path.join(P, `${id}.txt`), 'utf8');
  const meta = JSON.parse(fs.readFileSync(path.join(P, `${id}.input.json`), 'utf8'));
  const body = t.split('\n')
    .filter(l => !/^(YÊU CẦU|- summary|- scenarios|  title|  marketAnalysis|  sprint90|- timeline|ĐỊNH HƯỚNG|=== \[|$)/.test(l))
    .map(l => l.replace(/ \| nguồn:.*/, '').replace(/\(trung vị, khoảng P25-P75, n=\d+\)/, '').replace(/^- Giai đoạn: /, 'GĐ: ').replace(/^- Mong muốn \/ quyết định: /, 'QĐ: ')
      .replace(/ \(phương thức THPT, tổ hợp [^)]*\)/, '').replace(/\(chưa rõ theo năm hay học kỳ\)/, '(đơn vị chưa rõ)').replace(/ - nhóm nghề tham chiếu gần đúng, không trùng hoàn toàn với ngành học/, ' [GẦN ĐÚNG]').replace(/ - chỉ mang tính tham khảo, ngành học không có nhóm tuyển dụng tương ứng/, ' [CHỈ THAM KHẢO]'));
  console.log(`\n######## ${id} (${meta.stage})\n${body.join('\n')}`);
}
