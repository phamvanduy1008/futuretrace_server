/**
 * FutureTrace Knowledge Layer v2
 * =========================================================================
 * Thay thế dần ragService.js (regex trên chỉ mục có số giữ chỗ) bằng:
 *  - Dữ liệu chuẩn hóa có nguồn: data/knowledge/*.json (data_pipeline/build_knowledge.py,
 *    build_market_facts.py). Mỗi bản ghi tham chiếu sources.json (publisher, url, tier, năm).
 *  - Tìm kiếm lexical BM25 + fuzzy + prefix (MiniSearch) cho autocomplete trường/ngành và
 *    câu mô tả tự do, không phân biệt dấu tiếng Việt.
 *  - Fact Sheet: danh sách sự kiện có ID [F1..Fn] để đưa vào prompt; LLM phải dẫn ID khi dùng số,
 *    groundingService đối chiếu số trong văn bản với Fact Sheet.
 * =========================================================================
 */

const fs = require('fs');
const path = require('path');
const MiniSearch = require('minisearch');
const { normText } = require('./careerModelService').internals;
const admitModelService = require('./admitModelService');

const KB_DIR = path.join(__dirname, '../data/knowledge');

const readJson = (name, fallback) => {
  const p = path.join(KB_DIR, name);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : fallback;
};

const REGION_CITY = { reg_hn: 'Hanoi', reg_hcm: 'HCMC', reg_dn: 'Danang' };
const REGION_PROVINCES = { reg_hn: ['Hà Nội'], reg_hcm: ['TP HCM'], reg_dn: ['Đà Nẵng'] };

// Cách gọi thông dụng -> mã ngành chuẩn (khi người dùng không gõ đúng tên ngành trong danh mục)
const MAJOR_KEYWORDS = {
  'cntt': '7480201', 'cong nghe thong tin': '7480201', 'it': '7480201', 'lap trinh': '7480201',
  'khoa hoc may tinh': '7480101', 'ky thuat phan mem': '7480103', 'an toan thong tin': '7480202',
  'tri tue nhan tao': '7480107', 'ke toan': '7340301', 'kiem toan': '7340302', 'marketing': '7340115',
  'quan tri kinh doanh': '7340101', 'qtkd': '7340101', 'kinh doanh quoc te': '7340120',
  'thuong mai dien tu': '7340122', 'tai chinh ngan hang': '7340201', 'ngan hang': '7340201',
  'tai chinh': '7340201', 'quan tri nhan luc': '7340404', 'nhan su': '7340404',
  'logistics': '7510605', 'logistic': '7510605', 'chuoi cung ung': '7510605', 'xuat nhap khau': '7340120',
  'duoc': '7720201', 'duoc hoc': '7720201', 'duoc si': '7720201', 'y khoa': '7720101', 'bac si': '7720101',
  'dieu duong': '7720301', 'rang ham mat': '7720501', 'xet nghiem': '7720601',
  'luat': '7380101', 'luat kinh te': '7380107', 'ngon ngu anh': '7220201', 'tieng anh': '7220201',
  'ngon ngu trung': '7220204', 'tieng trung': '7220204', 'ngon ngu nhat': '7220209', 'tieng nhat': '7220209',
  'ngon ngu han': '7220210', 'tieng han': '7220210', 'du lich': '7810103', 'khach san': '7810201',
  'nha hang': '7810202', 'xay dung': '7580201', 'kien truc': '7580101', 'noi that': '7580108',
  'co khi': '7510201', 'o to': '7510205', 'dien tu': '7520207', 'dien': '7510301', 'tu dong hoa': '7520216',
  'cong nghe thuc pham': '7540101', 'tam ly': '7310401', 'truyen thong': '7320104', 'quan he cong chung': '7320108',
  'kinh te': '7310101', 'moi truong': '7850101',
  'su pham toan': '7140209', 'su pham ngu van': '7140217', 'su pham van': '7140217', 'su pham tieng anh': '7140231',
  'giao duc tieu hoc': '7140202', 'giao duc mam non': '7140201', 'su pham tin': '7140210'
};

const SCHOOL_STOPWORDS = new Set(['dai', 'hoc', 'truong', 'vien', 'tp', 'thanh', 'pho', 'quoc', 'gia', 'dan', 'lap', 'tu', 'thuc', 'cong']);

class KnowledgeService {
  constructor() {
    this.load();
  }

  load() {
    const t0 = Date.now();
    this.sources = readJson('sources.json', {});
    this.schools = readJson('schools.json', []);
    this.programs = readJson('programs.json', []);
    this.livingCosts = readJson('living_costs.json', []);
    this.marketFacts = readJson('market_facts.json', { industries: {} });
    this.crosswalk = readJson('crosswalk.json', null);
    this.quality = readJson('quality_report.json', null);
    this.studentJobs = readJson('student_jobs.json', null);       // thực tập / bán thời gian / thời vụ (D5)
    this.officialFacts = readJson('official_facts.json', null);   // lương tối thiểu, thu nhập, thất nghiệp (D6, tier A)

    this.schoolById = new Map(this.schools.map(s => [s.id, s]));
    // Tên ngành chuẩn hóa (bỏ ghi chú trong ngoặc) -> mã ngành, để khớp cụm từ trong câu tự do
    this.majorNames = new Map();
    for (const p of this.programs) {
      const name = normText(p.major_name.replace(/\(.*?\)/g, ''));
      if (name.length > 3 && p.major_code && !this.majorNames.has(name)) this.majorNames.set(name, p.major_code);
    }
    this.programById = new Map(this.programs.map(p => [p.id, p]));
    this.programsBySchool = new Map();
    for (const p of this.programs) {
      if (!this.programsBySchool.has(p.school_id)) this.programsBySchool.set(p.school_id, []);
      this.programsBySchool.get(p.school_id).push(p);
    }

    const options = {
      processTerm: (term) => normText(term) || null,
      tokenize: (text) => normText(text).split(' '),
      searchOptions: { prefix: true, fuzzy: 0.2, combineWith: 'AND' }
    };
    this.schoolIndex = new MiniSearch({ ...options, fields: ['name', 'aliasText', 'province'], storeFields: ['id'] });
    this.schoolIndex.addAll(this.schools.map(s => ({ id: s.id, name: s.name, aliasText: s.aliases.join(' '), province: s.province })));

    this.programIndex = new MiniSearch({
      ...options,
      fields: ['major_name', 'school_name', 'program_code'],
      storeFields: ['id'],
      searchOptions: { ...options.searchOptions, boost: { major_name: 2 } }
    });
    this.programIndex.addAll(this.programs.map(p => ({
      id: p.id, major_name: p.major_name, program_code: p.program_code,
      school_name: this.schoolById.get(p.school_id)?.name || ''
    })));

    console.log(`[Knowledge] Loaded ${this.schools.length} schools, ${this.programs.length} programs, ` +
      `${Object.keys(this.marketFacts.industries || {}).length} market segments in ${Date.now() - t0}ms`);
  }

  source(id) {
    const s = this.sources[id];
    return s ? { id, publisher: s.publisher, url: s.url, tier: s.tier, retrievedAt: s.retrieved_at, verified: !!s.verified } : null;
  }

  /** Autocomplete cho form có cấu trúc */
  search(query, { type = 'program', schoolId = null, limit = 8 } = {}) {
    if (!query || !query.trim()) return [];
    if (type === 'school') {
      return this.schoolIndex.search(query).slice(0, limit).map(r => {
        const s = this.schoolById.get(r.id);
        return { id: s.id, name: s.name, province: s.province, programs: this.programsBySchool.get(s.id)?.length || 0 };
      });
    }
    const filter = schoolId ? (r) => this.programById.get(r.id)?.school_id === schoolId : undefined;
    return this.programIndex.search(query, { filter }).slice(0, limit).map(r => this.describeProgram(this.programById.get(r.id)));
  }

  describeProgram(p) {
    if (!p) return null;
    const school = this.schoolById.get(p.school_id);
    return {
      id: p.id, schoolId: p.school_id, schoolName: school?.name, province: school?.province,
      majorName: p.major_name, majorCode: p.major_code, subjectGroups: p.subject_groups,
      cutoff: p.cutoff, year: p.year, method: p.method, tuitionVnd: p.tuition_vnd,
      occupation: p.occupation
    };
  }

  /**
   * Suy ra chương trình (trường + ngành) từ câu mô tả tự do khi người dùng chưa chọn từ autocomplete.
   * Ưu tiên khớp trường qua tên/viết tắt, sau đó chọn ngành khớp nhất trong trường đó.
   */
  resolveFromText(text) {
    if (!text) return { school: null, program: null, occupation: null, majorCode: null };
    const norm = ` ${normText(text)} `;
    // Câu nói về hoàn cảnh/băn khoăn ("Nhà em kinh tế không dư dả") không chứa tên trường: bỏ khi khớp trường
    const CONCERN = /(nha em|gia dinh|ban be|so ra truong|thu nhap|kinh te khong|phan van|chua chac|muon lam viec gan)/;
    const schoolNorm = ` ${normText(String(text).split(/[.!?\n]/).filter(sn => !CONCERN.test(normText(sn))).join(' '))} `;

    // 1. Ngành trước: mọi cụm khớp (từ điển cách gọi thông dụng + tên ngành trong danh mục)
    const matches = [];
    for (const [kw, code] of Object.entries(MAJOR_KEYWORDS)) {
      const pos = norm.indexOf(` ${kw} `);
      if (pos >= 0) matches.push({ phrase: kw, code, pos });
    }
    for (const [name, code] of this.majorNames) {
      const pos = norm.indexOf(` ${name} `);
      if (pos >= 0) matches.push({ phrase: name, code, pos });
    }
    // "chuyển sang / đổi sang X": ngành đích là cụm xuất hiện sau cùng; ngược lại lấy cụm dài nhất
    const switching = /\b(chuyen sang|doi sang|sang nganh|chuyen nganh sang)\b/.test(norm);
    // Cụm đứng ngay sau chữ "ngành" là ngành người dùng muốn học; ưu tiên hơn cụm trong câu băn khoăn
    // (vd. "Nhà em kinh tế không dư dả" không được kéo sang ngành Kinh tế)
    const afterNganh = new Set([...norm.matchAll(/ nganh /g)].map(m => m.index + 7));
    const lead = (m) => (afterNganh.has(m.pos + 1) ? 1 : 0);
    matches.sort((a, b) => (switching ? b.pos - a.pos : 0) || (lead(b) - lead(a)) || b.phrase.length - a.phrase.length);

    // 2. Trường: bỏ cụm tên ngành đã chọn khỏi câu (tránh "y khoa" khớp nhầm "ĐH Khoa học"), rồi khớp.
    //    Ứng viên ngành nằm trong chính tên trường được nhắc tới ("kinh tế" trong "ĐH Kinh tế") bị bỏ qua.
    const schoolOnFullText = this.matchSchool(schoolNorm);
    const schoolNameOf = (s) => (s ? ` ${normText(s.name)} ` : '');
    let best = null;
    let school = null;
    // Không có từ chỉ trường (đại học, trường, học viện...) thì tên ngành trùng tên trường ("Điều dưỡng" ~ "ĐH Điều dưỡng Nam Định")
    // không phải là nhắc tới trường đó
    const hasSchoolCue = /\b(dai hoc|truong|hoc vien|dh|cao dang)\b/.test(norm);
    for (const m of matches) {
      const bareMajor = lead(m) && !hasSchoolCue;
      if (!bareMajor && schoolNameOf(schoolOnFullText).includes(` ${m.phrase} `)) continue;
      const candidateSchool = this.matchSchool(schoolNorm.split(` ${m.phrase} `).join(' '));
      if (!bareMajor && schoolNameOf(candidateSchool).includes(` ${m.phrase} `)) continue;
      best = m;
      // candidateSchool được khớp trên câu đã bỏ cụm ngành, nên tên ngành trùng tên trường không bị tính là nhắc tới trường
      school = candidateSchool;
      break;
    }
    if (!best) {
      best = matches[0] || null;
      school = this.matchSchool(best ? schoolNorm.split(` ${best.phrase} `).join(' ') : schoolNorm);
    }
    const majorCode = best?.code || null;

    // 3. Chương trình trong trường: cùng mã ngành có thể có nhiều chương trình (CLC, phân hiệu...):
    //    ưu tiên chương trình chuẩn (tên không có ghi chú trong ngoặc), sau đó điểm cao nhất (cơ sở chính)
    let program = null;
    if (school && best) {
      const pool = this.programsBySchool.get(school.id) || [];
      const candidates = pool.filter(p => (majorCode && p.major_code === majorCode) ||
        normText(p.major_name.replace(/\(.*?\)/g, '')) === best.phrase);
      program = candidates.sort((a, b) =>
        (/\(/.test(a.major_name) - /\(/.test(b.major_name)) || b.cutoff - a.cutoff)[0] || null;
    }

    const occupation = program?.occupation || this.crosswalkLookup(majorCode);
    return { school, program, occupation, majorCode };
  }

  /** Crosswalk theo tiền tố mã ngành dài nhất (7 -> 3 chữ số); ngành không có thị trường tuyển dụng (fit=none) không có nhóm lương */
  crosswalkLookup(majorCode) {
    if (!majorCode || !this.crosswalk?.rules) return null;
    const code = this.crosswalk.code_fixes?.[majorCode] || majorCode;
    for (let n = code.length; n >= 3; n--) {
      const rec = this.crosswalk.rules[code.slice(0, n)];
      if (rec) return { ...rec, industry: rec.fit === 'none' ? null : rec.industry, match_level: n === 7 ? 'major' : 'field_group' };
    }
    return null;
  }

  /** Khớp trường trong câu đã chuẩn hóa: alias nguyên cụm, hoặc phủ >= 75% (tối thiểu 2) từ đặc trưng */
  matchSchool(normText_) {
    const words = new Set(normText_.trim().split(' '));
    let school = null;
    let bestScore = 0;
    for (const s of this.schools) {
      let score = 0;
      for (const alias of s.aliases) {
        const a = normText(alias);
        if (a.length >= 3 && normText_.includes(` ${a} `)) score = Math.max(score, 100 + a.length);
      }
      if (!score) {
        const distinctive = normText(s.name).split(' ').filter(w => w.length > 1 && !SCHOOL_STOPWORDS.has(w));
        const hit = distinctive.filter(w => words.has(w)).length;
        if (hit >= 2 && hit / distinctive.length >= 0.75) score = hit * 10 + hit / distinctive.length;
      }
      if (score > bestScore) {
        bestScore = score;
        school = s;
      }
    }
    return school;
  }

  /** Phân phối điểm chuẩn của một ngành theo khu vực (khi người dùng chưa chọn trường cụ thể) */
  cutoffStatsForMajor(majorCode, regionKey) {
    if (!majorCode) return null;
    const provinces = REGION_PROVINCES[regionKey];
    let rows = this.programs.filter(p => p.major_code === majorCode && !p.is_floor_score);
    const regional = provinces ? rows.filter(p => provinces.includes(this.schoolById.get(p.school_id)?.province)) : [];
    const scope = regional.length >= 3 ? provinces.join(', ') : 'toàn quốc';
    if (regional.length >= 3) rows = regional;
    if (rows.length < 3) return null;
    const scores = rows.map(p => p.cutoff).sort((a, b) => a - b);
    const q = (f) => scores[Math.min(scores.length - 1, Math.floor(f * scores.length))];
    return {
      scope, n: rows.length, min: scores[0], p50: q(0.5), max: scores[scores.length - 1],
      majorName: rows[0].major_name, year: rows[0].year, sourceId: rows[0].source_id
    };
  }

  marketForIndustry(industryText) {
    if (!industryText) return null;
    const segs = String(industryText).split('/').map(t => t.trim()).filter(Boolean);
    const hits = segs.map(t => [t, this.marketFacts.industries?.[normText(t)]]).filter(([, v]) => v);
    return hits.length ? { segment: hits[0][0], ...hits[0][1] } : null;
  }

  livingCostForRegion(regionKey) {
    const city = REGION_CITY[regionKey];
    return city ? this.livingCosts.find(c => c.city === city) || null : null;
  }

  /**
   * Fact Sheet cho một lượt mô phỏng.
   * @param {object} ctx { programId?, decisionText, regionKey?, quant? }
   */
  buildFactSheet(ctx = {}) {
    const facts = [];
    const add = (label, value, unit, extra = {}) => {
      facts.push({ id: `F${facts.length + 1}`, label, value, unit, ...extra });
    };

    const resolved = ctx.programId && this.programById.has(ctx.programId)
      ? { program: this.programById.get(ctx.programId), school: this.schoolById.get(this.programById.get(ctx.programId).school_id) }
      : this.resolveFromText(ctx.decisionText);
    const program = resolved.program;
    const school = resolved.school || (program && this.schoolById.get(program.school_id));
    const occupation = program?.occupation || resolved.occupation || null;

    if (program) {
      add(`Điểm chuẩn ${program.year} ngành ${program.major_name} - ${school?.name} (phương thức ${program.method}, tổ hợp ${program.subject_groups.join(', ') || 'n/a'})`,
        program.cutoff, `điểm/${program.scale}`, { year: program.year, source: this.source(program.source_id), kind: 'cutoff' });
      if (program.is_floor_score) {
        add('Ghi chú: điểm chuẩn bằng mức sàn, khả năng trúng tuyển phụ thuộc chủ yếu vào ngưỡng đảm bảo chất lượng', null, null,
          { source: this.source(program.source_id), kind: 'note' });
      }
      // FT-Admit: xác suất trúng tuyển với điểm dự kiến của người dùng
      const admit = Number.isFinite(Number(ctx.expectedScore)) && ctx.expectedScore !== undefined && ctx.expectedScore !== null
        ? admitModelService.probability(program, ctx.expectedScore)
        : null;
      if (admit) {
        const modelSource = { publisher: `Mô hình FT-Admit (${admit.calibrated ? `hiệu chỉnh bằng backtest, ${admit.yearsOfHistory} năm dữ liệu` : admit.sigmaLearned ? `độ biến động học từ ${admit.seriesUsed} chương trình qua 2 năm, chưa kiểm chứng ngoài mẫu` : 'ước lượng sơ bộ, chưa đủ dữ liệu nhiều năm để hiệu chỉnh'})`, tier: 'model' };
        add(`Điểm chuẩn dự báo năm ${admit.targetYear} của chương trình này (trung tâm, độ lệch chuẩn ±${admit.sigma})`,
          admit.mu, 'điểm/30', { range: [Math.round((admit.mu - admit.sigma) * 100) / 100, Math.round((admit.mu + admit.sigma) * 100) / 100], source: modelSource, kind: 'cutoff_forecast' });
        add(`Xác suất trúng tuyển ước tính với điểm dự kiến ${admit.score}`, admit.probability, '%', { source: modelSource, kind: 'admission_probability', calibrated: admit.calibrated });
      }
      if (program.tuition_vnd) {
        add(`Học phí ngành ${program.major_name} - ${school?.name} (chưa rõ theo năm hay học kỳ)`,
          Math.round(program.tuition_vnd / 1e5) / 10, 'triệu VNĐ', { source: this.source(program.source_id), kind: 'tuition' });
      }
    } else {
      const stats = this.cutoffStatsForMajor(resolved.majorCode, ctx.regionKey);
      if (stats) {
        add(`Điểm chuẩn ${stats.year} ngành ${stats.majorName} tại ${stats.scope} (trung vị của ${stats.n} chương trình, không tính mức sàn)`,
          stats.p50, 'điểm/30', { range: [stats.min, stats.max], year: stats.year, source: this.source(stats.sourceId), kind: 'cutoff_stats' });
      }
    }

    const market = this.marketForIndustry(occupation?.industry || ctx.industryText);
    if (market) {
      const src = { publisher: 'Tin tuyển dụng tổng hợp', tier: this.marketFacts.source?.tier, years: this.marketFacts.source?.years };
      const FIT_NOTE = {
        approx: ' - nhóm nghề tham chiếu gần đúng, không trùng hoàn toàn với ngành học',
        weak: ' - chỉ mang tính tham khảo, ngành học không có nhóm tuyển dụng tương ứng'
      };
      const refLabel = `ngành "${market.segment}"${occupation?.fit && occupation.fit !== 'strong' ? (FIT_NOTE[occupation.fit] || '') : ''}`;
      if (market.salary_million_fresher_graduate) {
        const s = market.salary_million_fresher_graduate;
        add(`Lương rao tuyển cho người mới tốt nghiệp CĐ/ĐH ${refLabel} (trung vị, khoảng P25-P75, n=${s.n})`,
          s.p50, 'triệu/tháng', { range: [s.p25, s.p75], source: src, kind: 'salary_fresher' });
      }
      const a = market.salary_million_all;
      add(`Lương rao tuyển mọi cấp độ ${refLabel} (trung vị, khoảng P25-P75, n=${a.n})`,
        a.p50, 'triệu/tháng', { range: [a.p25, a.p75], source: src, kind: 'salary_all' });
      add(`Số tin tuyển dụng ${refLabel} giai đoạn ${src.years?.join('-')}`, market.postings, 'tin', { source: src, kind: 'demand' });
    }

    if (market && String(program?.major_code || resolved.majorCode || '').startsWith('714')) {
      add('Ghi chú: tin tuyển dụng giáo dục chủ yếu của trung tâm và trường tư; giáo viên công lập hưởng thang lương nhà nước nên có thể khác mức lương rao tuyển', null, null,
        { source: { publisher: 'FutureTrace (ghi chú phương pháp)', tier: 'note' }, kind: 'note' });
    }

    if (occupation?.fit === 'none') {
      add('Ghi chú: ngành này không có dữ liệu tuyển dụng công khai (khu vực nhà nước, quân đội, công an hoặc biểu diễn nghệ thuật), hệ thống không ước lượng lương và ROI; chưa có dữ liệu', null, null,
        { source: { publisher: 'FutureTrace (ghi chú phương pháp)', tier: 'note' }, kind: 'note' });
    }

    const living = this.livingCostForRegion(ctx.regionKey);
    if (living) {
      add(`Ngân sách sinh hoạt sinh viên ước tính tại ${living.city} (ở ghép)`, living.student_budget_million_per_month, 'triệu/tháng',
        { source: this.source(living.source_id), kind: 'living_cost' });
    }

    // Số liệu theo giai đoạn (D7): sinh viên cần dữ liệu đi làm thêm / thực tập / thị trường lao động trẻ;
    // học sinh phân vân "đi học hay đi làm sớm" cần thu nhập bình quân và lương tối thiểu để so sánh
    const stage = String(ctx.stage || '');
    const isStudent = /^(DAI_HOC|CHUYEN_NGANH|KHOI_NGHIEP)/.test(stage);
    const weighsWorking = /đi làm|làm thêm|kiếm tiền|bỏ học/i.test(ctx.decisionText || '');
    const official = this.officialFacts?.facts || {};
    const addOfficial = (key, kind) => {
      const o = official[key];
      if (o) add(o.label, o.value, o.unit, { range: o.range, year: o.year, source: o.source, kind });
    };
    if (isStudent && this.studentJobs?.categories) {
      const region = { reg_hn: 'hanoi', reg_hcm: 'hcm', reg_dn: 'danang' }[ctx.regionKey];
      const jobSrc = { publisher: this.studentJobs.source?.publisher, tier: this.studentJobs.source?.tier, years: this.studentJobs.source?.years };
      const where = { hanoi: ' tại Hà Nội', hcm: ' tại TP.HCM', danang: ' tại Đà Nẵng' };
      for (const [key, kind] of [['part_time', 'job_part_time'], ['intern', 'job_intern']]) {
        const cat = this.studentJobs.categories[key];
        const q = (region && cat?.[region]) || cat?.all;
        if (!q) continue;
        const scope = region && cat?.[region] ? where[region] : ' (cả nước)';
        add(`Lương rao tuyển việc ${cat.label.toLowerCase()}${scope} (trung vị, khoảng P25-P75, n=${q.n}; lương rao tuyển, không phải thực nhận)`,
          q.p50, 'triệu/tháng', { range: [q.p25, q.p75], source: jobSrc, kind });
      }
      addOfficial('min_wage_hour', 'min_wage');
      addOfficial('youth_unemployment_2025', 'labor_market');
    } else if (weighsWorking) {
      addOfficial('avg_income_2025', 'labor_market');
      addOfficial('min_wage_month', 'min_wage');
      addOfficial('youth_unemployment_2025', 'labor_market');
    }

    return {
      facts,
      program: program ? this.describeProgram(program) : null,
      school: school ? { id: school.id, name: school.name, province: school.province } : null,
      occupation
    };
  }

  /** Định dạng Fact Sheet cho prompt: mỗi dòng có ID để LLM dẫn nguồn */
  formatFactSheet(sheet) {
    if (!sheet?.facts?.length) return '';
    const lines = ['=== [FACT SHEET - CHỈ DÙNG CÁC CON SỐ DƯỚI ĐÂY, GHI KÈM MÃ [F#] KHI TRÍCH] ==='];
    for (const f of sheet.facts) {
      const val = f.value === null || f.value === undefined ? '' : `: ${f.value}${f.unit ? ` ${f.unit}` : ''}`;
      const range = f.range ? ` (khoảng ${f.range[0]}-${f.range[1]})` : '';
      const src = f.source ? ` | nguồn: ${f.source.publisher}${f.source.years ? ` ${f.source.years.join('-')}` : ''}` : '';
      lines.push(`[${f.id}] ${f.label}${val}${range}${src}`);
    }
    return lines.join('\n');
  }
}

module.exports = new KnowledgeService();
