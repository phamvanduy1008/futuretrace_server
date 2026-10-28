const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const adminAuth = require('../middleware/adminAuth');
const requireRoles = require('../middleware/requireRoles');
const { createAuditLog } = require('../services/auditService');
const { formatDateTime } = require('../services/adminFormatters');
const ragService = require('../services/ragService');

const router = express.Router();

const RAG_DIR = path.join(__dirname, '..', 'data', 'rag');
const BASE_DIR = path.join(__dirname, '..', '..');

const formatBytes = (bytes) => {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
};

const stripAccents = (str) => {
  if (!str || typeof str !== 'string') return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim();
};

/**
 * Lấy danh sách thống kê các chỉ mục RAG hiện có
 */
const getRagIndicesStats = () => {
  if (!fs.existsSync(RAG_DIR)) {
    fs.mkdirSync(RAG_DIR, { recursive: true });
  }

  const indices = [
    {
      id: 'admissions',
      fileName: 'admissions_index.json',
      title: 'Điểm Chuẩn Tuyển Sinh (183 Trường)',
      description: 'Chỉ mục tra cứu điểm chuẩn, học phí và tổ hợp xét tuyển toàn quốc.',
      source: 'diem_chuan_tat_ca_cac_truong.xlsx'
    },
    {
      id: 'salaries',
      fileName: 'salaries_index.json',
      title: 'Thống Kê Lương & Thu Nhập (6.220 Chức Danh)',
      description: 'Mức lương Fresher, Mid, Senior, Manager từ VietnamWorks & thị trường.',
      source: 'luong_trung_binh_vietnamworks.xlsx'
    },
    {
      id: 'living_costs',
      fileName: 'living_costs_index.json',
      title: 'Chi Phí Sinh Hoạt Đô Thị (Numbeo)',
      description: 'Chi phí tiền trọ, ăn uống, sinh hoạt tại các thành phố lớn.',
      source: 'numbeo_cost_of_living.json'
    },
    {
      id: 'market_intelligence',
      fileName: 'market_intelligence.json',
      title: 'Phân Tích Thị Trường Tuyển Dụng',
      description: 'Thông tin phân tích từ 606.000+ tin tuyển dụng thực tế năm 2022-2026.',
      source: 'data.parquet'
    },
    {
      id: 'domains',
      fileName: 'domains_index.json',
      title: 'Bản Đồ Ngành Nghề & Holland RIASEC',
      description: 'Ánh xạ 15 khối ngành trọng điểm với 6 nhóm tính cách Holland.',
      source: 'vietnam_salaries_by_industry.csv'
    }
  ];

  return indices.map((idx) => {
    const filePath = path.join(RAG_DIR, idx.fileName);
    let exists = false;
    let sizeBytes = 0;
    let updatedAt = null;
    let count = 0;
    let idxUnit = 'mục';
    let detailInfo = '';

    if (fs.existsSync(filePath)) {
      exists = true;
      const stats = fs.statSync(filePath);
      sizeBytes = stats.size;
      updatedAt = formatDateTime(stats.mtime);

      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
          count = data.length;
        } else if (typeof data === 'object' && data !== null) {
          if (Array.isArray(data.roles)) {
            count = data.roles.length + (data.industries ? data.industries.length : 0);
          } else {
            count = Object.keys(data).length;
          }
        }

        if (idx.id === 'market_intelligence' && typeof data === 'object') {
          const totalPostings = Object.values(data).reduce((acc, curr) => acc + (curr.total_postings || 0), 0);
          idxUnit = 'khối ngành';
          detailInfo = `Tổng hợp từ ${totalPostings.toLocaleString('vi-VN')} tin tuyển dụng`;
        } else if (idx.id === 'admissions' && typeof data === 'object') {
          const totalMajors = Object.values(data).reduce((acc, curr) => acc + (curr.majors ? curr.majors.length : 0), 0);
          idxUnit = 'trường ĐH';
          detailInfo = `Bao gồm ${totalMajors.toLocaleString('vi-VN')} ngành đào tạo`;
        } else if (idx.id === 'salaries') {
          idxUnit = 'chức danh';
          detailInfo = 'Dữ liệu Fresher đến Senior';
        } else if (idx.id === 'living_costs') {
          idxUnit = 'đô thị lớn';
          detailInfo = 'Chi phí trọ, ăn uống, đi lại';
        } else if (idx.id === 'domains') {
          idxUnit = 'khối ngành';
          detailInfo = 'Ánh xạ 6 nhóm tính cách Holland';
        }
      } catch (e) {
        // file parsing warning
      }
    }

    return {
      ...idx,
      exists,
      sizeBytes,
      sizeFormatted: formatBytes(sizeBytes),
      updatedAt: updatedAt || 'Chưa lập chỉ mục',
      count,
      unitLabel: idxUnit || 'mục',
      detailInfo: detailInfo || ''
    };
  });
};

/**
 * GET /api/admin/rag/status
 * Trả về báo cáo trạng thái kho tri thức RAG
 */
router.get('/status', adminAuth, requireRoles('super_admin', 'ops_support', 'ai_operator'), async (req, res) => {
  try {
    const indices = getRagIndicesStats();
    const totalRecords = indices.reduce((acc, curr) => acc + (curr.count || 0), 0);
    const totalSizeBytes = indices.reduce((acc, curr) => acc + (curr.sizeBytes || 0), 0);

    // Kiểm tra và tổng hợp metadata các tệp gốc
    const rawFilesConfig = [
      {
        name: 'diem_chuan_tat_ca_cac_truong.xlsx',
        title: 'Điểm chuẩn 183 trường Đại học',
        fileType: 'xlsx',
        description: 'Dữ liệu xét tuyển, điểm chuẩn, khối thi toàn quốc'
      },
      {
        name: 'luong_trung_binh_vietnamworks.xlsx',
        title: 'Thống kê lương VietnamWorks',
        fileType: 'xlsx',
        description: 'Báo cáo thu nhập theo vị trí, cấp bậc Fresher - Senior'
      },
      {
        name: 'ielts_conversion_data.xlsx',
        title: 'Bảng quy đổi chứng chỉ ngoại ngữ',
        fileType: 'xlsx',
        description: 'Quy đổi IELTS, TOEIC sang điểm chuẩn đại học'
      },
      {
        name: 'numbeo_cost_of_living.json',
        title: 'Chỉ số vật giá sinh hoạt Numbeo',
        fileType: 'json',
        description: 'Chi phí phòng trọ, ăn uống, đi lại tại Hà Nội, TP.HCM, Đà Nẵng'
      },
      {
        name: 'vietnam_salaries_by_industry.csv',
        title: 'Bản đồ thu nhập 15 ngành nghề',
        fileType: 'csv',
        description: 'Thu nhập trung vị theo các nhóm ngành nghề và Holland RIASEC'
      },
      {
        name: 'data.parquet',
        title: 'Big Data 606k tin tuyển dụng',
        fileType: 'parquet',
        description: 'Kho dữ liệu lớn phân tích kỹ năng và xu hướng thị trường 2022-2026'
      },
    ];

    const rawSources = rawFilesConfig.map(cfg => {
      const p = path.join(BASE_DIR, cfg.name);
      const exists = fs.existsSync(p);
      let sizeBytes = 0;
      let updatedAt = null;

      if (exists) {
        try {
          const stat = fs.statSync(p);
          sizeBytes = stat.size;
          updatedAt = formatDateTime(stat.mtime);
        } catch (e) {
          // ignore
        }
      }

      return {
        ...cfg,
        exists,
        sizeBytes,
        sizeFormatted: exists ? formatBytes(sizeBytes) : '0 B',
        updatedAt: updatedAt || 'Chưa tìm thấy'
      };
    });

    const totalRawSizeBytes = rawSources.reduce((acc, curr) => acc + (curr.sizeBytes || 0), 0);

    res.json({
      status: 'healthy',
      totalRecords,
      totalSize: formatBytes(totalSizeBytes),
      totalRawSize: formatBytes(totalRawSizeBytes),
      indices,
      rawSources,
      lastSync: indices[0]?.updatedAt || 'N/A'
    });
  } catch (error) {
    console.error('Admin RAG status error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống khi lấy trạng thái RAG.' });
  }
});

/**
 * POST /api/admin/rag/sync
 * Thực hiện đồng bộ và xây dựng lại chỉ mục RAG từ các nguồn dữ liệu gốc
 */
router.post('/sync', adminAuth, requireRoles('super_admin', 'ops_support', 'ai_operator'), async (req, res) => {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'build_rag_knowledge.py');
  console.log(`[RAG Sync] 🔄 Admin ${req.admin?.email} kích hoạt đồng bộ RAG...`);

  const runBuildScript = () => {
    return new Promise((resolve) => {
      exec(`python "${scriptPath}"`, { timeout: 60000 }, (error, stdout, stderr) => {
        if (error) {
          console.warn('[RAG Sync] Python execution warning:', error.message);
          resolve({ stdout, stderr, warning: error.message });
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  };

  try {
    const result = await runBuildScript();
    
    // Tải lại bộ nhớ RAG service
    if (ragService && typeof ragService.loadIndices === 'function') {
      ragService.loadIndices();
    }

    const updatedStats = getRagIndicesStats();

    await createAuditLog({
      actor: req.admin,
      action: 'sync_rag_knowledge',
      resourceType: 'rag_knowledge',
      resourceId: 'rag_indices',
      resourceName: 'FutureTrace RAG Knowledge Hub',
      summary: 'Admin đồng bộ và cập nhật lại toàn bộ chỉ mục tri thức RAG.',
      severity: 'info',
      reason: req.body?.reason || 'Đồng bộ định kỳ từ Admin UI',
      after: { updatedStats },
      req,
    });

    res.json({
      success: true,
      message: 'Đồng bộ và cập nhật cơ sở tri thức RAG thành công!',
      output: result.stdout?.substring(0, 500) || 'Chỉ mục đã được đồng bộ chuẩn xác.',
      indices: updatedStats
    });
  } catch (error) {
    console.error('RAG sync error:', error);
    res.status(500).json({ message: 'Lỗi trong quá trình đồng bộ RAG: ' + error.message });
  }
});

/**
 * POST /api/admin/rag/add-entry
 * Thêm một mục tri thức mới trực tiếp vào kho RAG
 */
router.post('/add-entry', adminAuth, requireRoles('super_admin', 'ops_support', 'ai_operator'), async (req, res) => {
  try {
    const { category, data } = req.body || {};
    if (!category || !data) {
      return res.status(400).json({ message: 'Vui lòng cung cấp category và dữ liệu cần thêm.' });
    }

    let targetFile = '';
    let successMessage = '';

    if (category === 'salaries') {
      targetFile = path.join(RAG_DIR, 'salaries_index.json');
      if (!data.title) {
        return res.status(400).json({ message: 'Vui lòng nhập tên chức danh công việc.' });
      }

      let salariesObj = { roles: [], industries: [] };
      if (fs.existsSync(targetFile)) {
        try {
          salariesObj = JSON.parse(fs.readFileSync(targetFile, 'utf-8'));
          if (!Array.isArray(salariesObj.roles)) salariesObj.roles = [];
        } catch (e) {}
      }

      const minVnd = parseFloat(data.minVnd) || 10.0;
      const avgVnd = parseFloat(data.avgVnd) || 20.0;
      const maxVnd = parseFloat(data.maxVnd) || 35.0;

      const newRole = {
        title: data.title.trim(),
        title_norm: stripAccents(data.title),
        salary_usd: {
          min: Math.round(minVnd * 1000000 / 25400),
          avg: Math.round(avgVnd * 1000000 / 25400),
          max: Math.round(maxVnd * 1000000 / 25400)
        },
        salary_vnd_million: {
          min: minVnd,
          avg: avgVnd,
          max: maxVnd
        },
        sample_size: parseInt(data.sampleSize) || 50
      };

      // Kiểm tra xem chức danh đã tồn tại chưa để Smart Upsert (Cập nhật hoặc Thêm mới)
      const titleNorm = stripAccents(data.title);
      const existingRoleIndex = salariesObj.roles.findIndex(r => stripAccents(r.title) === titleNorm);

      if (existingRoleIndex >= 0) {
        // CẬP NHẬT đè thông tin mới nhất vào chức danh đã có, KHÔNG tạo trùng lặp
        salariesObj.roles[existingRoleIndex] = {
          ...salariesObj.roles[existingRoleIndex],
          ...newRole
        };
        successMessage = `Đã cập nhật (Smart Update) mức lương mới nhất cho chức danh "${newRole.title}"!`;
      } else {
        // Thêm mới chức danh
        salariesObj.roles.unshift(newRole);
        successMessage = `Đã thêm mới chức danh "${newRole.title}" vào chỉ mục Lương!`;
      }

      fs.writeFileSync(targetFile, JSON.stringify(salariesObj, null, 2), 'utf-8');

    } else if (category === 'admissions') {
      targetFile = path.join(RAG_DIR, 'admissions_index.json');
      if (!data.schoolName || !data.majorName) {
        return res.status(400).json({ message: 'Vui lòng nhập tên trường và tên ngành học.' });
      }

      let admissionsList = [];
      if (fs.existsSync(targetFile)) {
        try {
          admissionsList = JSON.parse(fs.readFileSync(targetFile, 'utf-8'));
        } catch (e) {}
      }

      const schoolNorm = stripAccents(data.schoolName);
      let existingSchool = admissionsList.find(s => stripAccents(s.school_name) === schoolNorm);

      const newMajor = {
        major_name: data.majorName.trim(),
        major_code: data.majorCode ? data.majorCode.trim() : '7000000',
        cutoff_score: parseFloat(data.cutoffScore) || 20.0,
        subject_group: data.subjectGroup ? data.subjectGroup.trim() : 'A00,A01,D01',
        tuition_vnd: data.tuitionVnd ? parseFloat(data.tuitionVnd) : null,
        notes: data.notes || ''
      };

      if (existingSchool) {
        if (!Array.isArray(existingSchool.majors)) existingSchool.majors = [];
        const majorNorm = stripAccents(newMajor.major_name);
        const existingMajorIndex = existingSchool.majors.findIndex(m => stripAccents(m.major_name) === majorNorm);

        if (existingMajorIndex >= 0) {
          // CẬP NHẬT đè điểm chuẩn mới nhất cho ngành này, không sinh dòng trùng lặp
          existingSchool.majors[existingMajorIndex] = {
            ...existingSchool.majors[existingMajorIndex],
            ...newMajor
          };
          successMessage = `Đã cập nhật (Smart Update) điểm chuẩn mới cho ngành "${newMajor.major_name}" - ${existingSchool.school_name}!`;
        } else {
          // Ngành mới trong trường cũ
          existingSchool.majors.unshift(newMajor);
          successMessage = `Đã thêm ngành mới "${newMajor.major_name}" vào ${existingSchool.school_name}!`;
        }
      } else {
        // Trường hoàn toàn mới
        admissionsList.unshift({
          school_name: data.schoolName.trim(),
          province: data.province ? data.province.trim() : 'Toàn quốc',
          aliases: [data.schoolName.toLowerCase().trim(), stripAccents(data.schoolName)],
          majors: [newMajor]
        });
        successMessage = `Đã thêm trường mới "${data.schoolName}" và ngành "${newMajor.major_name}" vào chỉ mục Tuyển sinh!`;
      }

      fs.writeFileSync(targetFile, JSON.stringify(admissionsList, null, 2), 'utf-8');

    } else if (category === 'living_costs') {
      targetFile = path.join(RAG_DIR, 'living_costs_index.json');
      if (!data.city) {
        return res.status(400).json({ message: 'Vui lòng nhập tên tỉnh/thành phố.' });
      }

      let livingCostsObj = {};
      if (fs.existsSync(targetFile)) {
        try {
          livingCostsObj = JSON.parse(fs.readFileSync(targetFile, 'utf-8'));
        } catch (e) {}
      }

      const cityKey = data.city.trim();
      const studentMillion = parseFloat(data.studentMillion) || 8.5;
      const isExisting = Boolean(livingCostsObj[cityKey]);

      livingCostsObj[cityKey] = {
        city: cityKey,
        city_norm: stripAccents(cityKey),
        living_cost_level: data.level || 'Medium',
        estimated_monthly_student_vnd: Math.round(studentMillion * 1000000),
        estimated_monthly_student_million: studentMillion,
        sample_costs: {
          inexpensive_meal_vnd: parseFloat(data.mealVnd) || 45000,
          rent_outside_centre_vnd: parseFloat(data.rentVnd) || 3000000,
          coffee_vnd: parseFloat(data.coffeeVnd) || 30000
        }
      };

      fs.writeFileSync(targetFile, JSON.stringify(livingCostsObj, null, 2), 'utf-8');
      successMessage = isExisting
        ? `Đã cập nhật chỉ số chi phí sinh hoạt mới cho "${cityKey}"!`
        : `Đã thêm đô thị mới "${cityKey}" vào cơ sở tri thức sinh hoạt!`;

    } else {
      return res.status(400).json({ message: 'Phân loại tri thức không hợp lệ. Chọn salaries, admissions hoặc living_costs.' });
    }

    // Nạp lại bộ nhớ RAG service ngay lập tức
    if (ragService && typeof ragService.loadIndices === 'function') {
      ragService.loadIndices();
    }

    // Ghi audit log
    await createAuditLog({
      actor: req.admin,
      action: 'add_rag_knowledge',
      resourceType: 'rag_knowledge',
      resourceId: category,
      resourceName: `Thêm tri thức RAG (${category})`,
      summary: successMessage,
      severity: 'info',
      reason: req.body?.reason || 'Thêm tri thức từ Admin UI',
      after: data,
      req
    });

    res.json({
      success: true,
      message: successMessage,
      indices: getRagIndicesStats()
    });
  } catch (error) {
    console.error('Error adding RAG knowledge:', error);
    res.status(500).json({ message: 'Lỗi khi thêm tri thức RAG: ' + error.message });
  }
});

/**
 * POST /api/admin/rag/bulk-import
 * Nhập dữ liệu hàng loạt vào cơ sở tri thức RAG với cơ chế Smart Upsert (Khử trùng lặp tự động)
 */
router.post('/bulk-import', adminAuth, requireRoles('super_admin', 'ops_support', 'ai_operator'), async (req, res) => {
  try {
    const { category, items } = req.body || {};
    if (!category || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'Vui lòng cung cấp phân loại tri thức và mảng dữ liệu (items) cần nhập.' });
    }

    let addedCount = 0;
    let updatedCount = 0;

    if (category === 'salaries') {
      const targetFile = path.join(RAG_DIR, 'salaries_index.json');
      let salariesObj = { roles: [], industries: [] };
      if (fs.existsSync(targetFile)) {
        try {
          salariesObj = JSON.parse(fs.readFileSync(targetFile, 'utf-8'));
          if (!Array.isArray(salariesObj.roles)) salariesObj.roles = [];
        } catch (e) {}
      }

      for (const item of items) {
        if (!item.title || !String(item.title).trim()) continue;
        const titleTrim = String(item.title).trim();
        const titleNorm = stripAccents(titleTrim);
        const minVnd = parseFloat(item.minVnd || item.min_vnd || item.min) || 10.0;
        const avgVnd = parseFloat(item.avgVnd || item.avg_vnd || item.avg) || 20.0;
        const maxVnd = parseFloat(item.maxVnd || item.max_vnd || item.max) || 35.0;

        const roleData = {
          title: titleTrim,
          title_norm: titleNorm,
          salary_usd: {
            min: Math.round(minVnd * 1000000 / 25400),
            avg: Math.round(avgVnd * 1000000 / 25400),
            max: Math.round(maxVnd * 1000000 / 25400)
          },
          salary_vnd_million: { min: minVnd, avg: avgVnd, max: maxVnd },
          sample_size: parseInt(item.sampleSize || item.sample_size) || 50
        };

        const existingIdx = salariesObj.roles.findIndex(r => stripAccents(r.title) === titleNorm);
        if (existingIdx >= 0) {
          salariesObj.roles[existingIdx] = { ...salariesObj.roles[existingIdx], ...roleData };
          updatedCount++;
        } else {
          salariesObj.roles.unshift(roleData);
          addedCount++;
        }
      }

      fs.writeFileSync(targetFile, JSON.stringify(salariesObj, null, 2), 'utf-8');

    } else if (category === 'admissions') {
      const targetFile = path.join(RAG_DIR, 'admissions_index.json');
      let admissionsList = [];
      if (fs.existsSync(targetFile)) {
        try {
          admissionsList = JSON.parse(fs.readFileSync(targetFile, 'utf-8'));
        } catch (e) {}
      }

      for (const item of items) {
        const schoolName = String(item.schoolName || item.school_name || item.school || '').trim();
        const majorName = String(item.majorName || item.major_name || item.major || '').trim();
        if (!schoolName || !majorName) continue;

        const schoolNorm = stripAccents(schoolName);
        let schoolObj = admissionsList.find(s => stripAccents(s.school_name) === schoolNorm);

        const majorData = {
          major_name: majorName,
          major_code: item.majorCode || item.major_code || '7000000',
          cutoff_score: parseFloat(item.cutoffScore || item.cutoff_score || item.score) || 20.0,
          subject_group: item.subjectGroup || item.subject_group || 'A00,A01,D01',
          tuition_vnd: item.tuitionVnd ? parseFloat(item.tuitionVnd) : null,
          notes: item.notes || ''
        };

        if (schoolObj) {
          if (!Array.isArray(schoolObj.majors)) schoolObj.majors = [];
          const majorNorm = stripAccents(majorName);
          const existingMajorIdx = schoolObj.majors.findIndex(m => stripAccents(m.major_name) === majorNorm);

          if (existingMajorIdx >= 0) {
            schoolObj.majors[existingMajorIdx] = { ...schoolObj.majors[existingMajorIdx], ...majorData };
            updatedCount++;
          } else {
            schoolObj.majors.unshift(majorData);
            addedCount++;
          }
        } else {
          admissionsList.unshift({
            school_name: schoolName,
            province: item.province ? String(item.province).trim() : 'Toàn quốc',
            aliases: [schoolName.toLowerCase(), schoolNorm],
            majors: [majorData]
          });
          addedCount++;
        }
      }

      fs.writeFileSync(targetFile, JSON.stringify(admissionsList, null, 2), 'utf-8');

    } else if (category === 'living_costs') {
      const targetFile = path.join(RAG_DIR, 'living_costs_index.json');
      let livingCostsObj = {};
      if (fs.existsSync(targetFile)) {
        try {
          livingCostsObj = JSON.parse(fs.readFileSync(targetFile, 'utf-8'));
        } catch (e) {}
      }

      for (const item of items) {
        const cityKey = String(item.city || item.name || '').trim();
        if (!cityKey) continue;
        const studentMillion = parseFloat(item.studentMillion || item.student_million || item.cost) || 8.5;
        const isExisting = Boolean(livingCostsObj[cityKey]);

        livingCostsObj[cityKey] = {
          city: cityKey,
          city_norm: stripAccents(cityKey),
          living_cost_level: item.level || 'Medium',
          estimated_monthly_student_vnd: Math.round(studentMillion * 1000000),
          estimated_monthly_student_million: studentMillion,
          sample_costs: {
            inexpensive_meal_vnd: parseFloat(item.mealVnd || item.meal) || 45000,
            rent_outside_centre_vnd: parseFloat(item.rentVnd || item.rent) || 3000000,
            coffee_vnd: parseFloat(item.coffeeVnd || item.coffee) || 30000
          }
        };

        if (isExisting) updatedCount++;
        else addedCount++;
      }

      fs.writeFileSync(targetFile, JSON.stringify(livingCostsObj, null, 2), 'utf-8');
    } else {
      return res.status(400).json({ message: 'Phân loại tri thức không hợp lệ.' });
    }

    if (ragService && typeof ragService.loadIndices === 'function') {
      ragService.loadIndices();
    }

    const summaryMsg = `Nhập hàng loạt hoàn tất! Đã thêm mới: ${addedCount} bản ghi, Cập nhật thông minh: ${updatedCount} bản ghi. Không phát sinh trùng lặp.`;

    await createAuditLog({
      actor: req.admin,
      action: 'bulk_import_rag_knowledge',
      resourceType: 'rag_knowledge',
      resourceId: category,
      resourceName: `Nhập hàng loạt tri thức RAG (${category})`,
      summary: summaryMsg,
      severity: 'info',
      reason: `Nhập hàng loạt ${items.length} bản ghi`,
      after: { addedCount, updatedCount, totalProcessed: items.length },
      req
    });

    res.json({
      success: true,
      message: summaryMsg,
      addedCount,
      updatedCount,
      totalProcessed: addedCount + updatedCount,
      indices: getRagIndicesStats()
    });
  } catch (error) {
    console.error('Error bulk importing RAG knowledge:', error);
    res.status(500).json({ message: 'Lỗi khi nhập hàng loạt dữ liệu: ' + error.message });
  }
});

/**
 * GET /api/admin/rag/search?q=...
 * Tra cứu thử nghiệm dữ liệu đa kênh trong chỉ mục RAG
 */
router.get('/search', adminAuth, requireRoles('super_admin', 'ops_support', 'ai_operator'), async (req, res) => {
  try {
    const rawQ = String(req.query.q || '').trim();
    if (!rawQ) {
      return res.json({ query: '', total: 0, results: [] });
    }

    const q = rawQ.toLowerCase();
    const qNorm = stripAccents(rawQ);
    const isSalaryQuery = ['luong', 'salary', 'thu nhap', 'tien luong', 'muc luong'].some(k => qNorm.includes(k));
    const results = [];

    // 1. Channel Salaries: salaries_index.json (6.220 roles & industries)
    const salariesPath = path.join(RAG_DIR, 'salaries_index.json');
    if (fs.existsSync(salariesPath)) {
      try {
        const salaries = JSON.parse(fs.readFileSync(salariesPath, 'utf-8'));
        const roles = Array.isArray(salaries.roles) ? salaries.roles : (Array.isArray(salaries) ? salaries : []);
        const industries = Array.isArray(salaries.industries) ? salaries.industries : [];

        // Tìm trong mảng industries tiếng Việt
        industries.forEach(ind => {
          const nameNorm = ind.name_norm || stripAccents(ind.name || '');
          const traitsNorm = stripAccents(ind.required_traits || '');
          if (isSalaryQuery || nameNorm.includes(qNorm) || traitsNorm.includes(qNorm)) {
            if (results.filter(r => r.type.includes('Ngành (VietnamWorks)')).length < 6) {
              results.push({
                type: 'Thống Kê Lương Ngành (VietnamWorks)',
                title: ind.name,
                detail: `Khởi điểm: ${ind.entry_salary_range || '10-15'} tr VNĐ/tháng | Trung bình: ${ind.avg_salary_range || '20-35'} tr VNĐ/tháng | Xu hướng: ${ind.hiring_trend || 'Tăng trưởng'}`,
                raw: ind
              });
            }
          }
        });

        // Tìm trong mảng roles (chức danh)
        let matchedRoles = [];
        if (isSalaryQuery && (qNorm === 'luong' || qNorm === 'salary' || qNorm === 'thu nhap' || qNorm === 'muc luong')) {
          // Khi gõ "lương" chung chung, trả về top các chức danh đại diện tiêu biểu có mức lương cao & phổ biến
          matchedRoles = roles.slice(0, 8);
        } else {
          // Bóc tách từ khóa (bỏ qua từ 'lương', 'thu nhập' để tìm tên vị trí, ví dụ 'lương developer' -> tìm 'developer')
          const cleanToken = qNorm.replace(/\b(luong|salary|thu nhap|tien luong|muc luong|muc)\b/g, '').trim();
          const target = cleanToken || qNorm;
          matchedRoles = roles.filter(r => {
            const titleNorm = r.title_norm || stripAccents(r.title || '');
            return titleNorm.includes(target);
          }).slice(0, 10);
        }

        matchedRoles.forEach(r => {
          const vnd = r.salary_vnd_million || {};
          const usd = r.salary_usd || {};
          results.push({
            type: 'Chức Danh & Mức Lương Thị Trường',
            title: r.title,
            detail: `Lương TB: ${vnd.avg ? vnd.avg + ' tr VNĐ/tháng' : (usd.avg ? '$' + usd.avg : 'Thương lượng')} (Dải: ${vnd.min || 0} - ${vnd.max || 0} tr) | Mẫu khảo sát: ${r.sample_size || 'Nhiều'} tin`,
            raw: r
          });
        });
      } catch (err) {
        console.error('Error searching salaries:', err);
      }
    }

    // 2. Channel Market Intelligence: market_intelligence.json (606.000 tin tuyển dụng thực tế)
    const marketPath = path.join(RAG_DIR, 'market_intelligence.json');
    if (fs.existsSync(marketPath)) {
      try {
        const marketIntel = JSON.parse(fs.readFileSync(marketPath, 'utf-8'));
        for (const [indName, indData] of Object.entries(marketIntel)) {
          const indNorm = stripAccents(indName);
          const sampleRolesNorm = (indData.sample_roles || []).map(stripAccents).join(' ');
          const cleanToken = qNorm.replace(/\b(luong|salary|thu nhap|muc luong)\b/g, '').trim();

          const matched = isSalaryQuery && (qNorm === 'luong' || qNorm === 'salary' || qNorm === 'thu nhap' || qNorm === 'muc luong')
            ? true
            : (cleanToken ? (indNorm.includes(cleanToken) || sampleRolesNorm.includes(cleanToken)) : (indNorm.includes(qNorm) || sampleRolesNorm.includes(qNorm)));

          if (matched && results.filter(r => r.type.includes('Thị Trường Tuyển Dụng')).length < 5) {
            const sal = indData.salary_vnd_million || {};
            results.push({
              type: 'Thị Trường Tuyển Dụng (606k Tin Thực Tế)',
              title: `Ngành ${indName} (${indData.total_postings?.toLocaleString('vi-VN')} tin tuyển)`,
              detail: `Lương trung vị: ${sal.avg_median || 15} tr VNĐ/tháng (Min: ${sal.min_median || 8} tr - Max: ${sal.max_median || 25} tr) | ĐH: ${indData.education_requirement?.university_percent || 0}%`,
              raw: indData
            });
          }
        }
      } catch (err) {
        console.error('Error searching market intel:', err);
      }
    }

    // 3. Channel Admissions: admissions_index.json (183 trường, 3.600+ ngành)
    const admissionsPath = path.join(RAG_DIR, 'admissions_index.json');
    if (fs.existsSync(admissionsPath)) {
      try {
        const admissions = JSON.parse(fs.readFileSync(admissionsPath, 'utf-8'));
        let admCount = 0;

        for (const school of admissions) {
          if (admCount >= 8) break;
          const schoolNorm = stripAccents(school.school_name || '');
          const aliasesNorm = (school.aliases || []).map(stripAccents);
          const schoolMatched = schoolNorm.includes(qNorm) || aliasesNorm.some(a => a.includes(qNorm));

          const matchingMajors = (school.majors || []).filter(m => {
            const mNorm = stripAccents(m.major_name || '');
            return schoolMatched || mNorm.includes(qNorm);
          });

          if (matchingMajors.length > 0) {
            matchingMajors.slice(0, 3).forEach(m => {
              if (admCount < 8) {
                admCount++;
                results.push({
                  type: 'Tuyển Sinh & Điểm Chuẩn',
                  title: `${school.school_name} - ${m.major_name}`,
                  detail: `Điểm chuẩn: ${m.cutoff_score || 'N/A'} | Khối: ${m.subject_group || 'N/A'} | Tỉnh: ${school.province || 'Toàn quốc'}${m.tuition_vnd ? ' | Học phí: ' + Number(m.tuition_vnd).toLocaleString('vi-VN') + ' đ' : ''}`,
                  raw: { school: school.school_name, ...m }
                });
              }
            });
          }
        }
      } catch (err) {
        console.error('Error searching admissions:', err);
      }
    }

    // 4. Channel Living Costs: living_costs_index.json
    const livingCostsPath = path.join(RAG_DIR, 'living_costs_index.json');
    if (fs.existsSync(livingCostsPath)) {
      try {
        const livingCosts = JSON.parse(fs.readFileSync(livingCostsPath, 'utf-8'));
        for (const [cityName, cityData] of Object.entries(livingCosts)) {
          const cityNorm = stripAccents(cityName);
          if (cityNorm.includes(qNorm) || (qNorm.includes('chi phi') || qNorm.includes('sinh hoat') || qNorm.includes('tien tro'))) {
            if (results.filter(r => r.type.includes('Chi Phí Sinh Hoạt')).length < 3) {
              results.push({
                type: 'Chi Phí Sinh Hoạt Đô Thị (Numbeo)',
                title: `Chi phí tại ${cityData.city || cityName}`,
                detail: `Ước tính SV: ~${cityData.estimated_monthly_student_million || 10} triệu VNĐ/tháng | Tiền trọ ngoài TT: ~${(Math.round((cityData.sample_costs?.rent_outside_centre_vnd || 0) / 1000000)).toLocaleString('vi-VN')} tr | Suất ăn: ~${(cityData.sample_costs?.inexpensive_meal_vnd || 0).toLocaleString('vi-VN')} đ`,
                raw: cityData
              });
            }
          }
        }
      } catch (err) {}
    }

    // 5. Channel Domains: domains_index.json
    const domainsPath = path.join(RAG_DIR, 'domains_index.json');
    if (fs.existsSync(domainsPath)) {
      try {
        const domains = JSON.parse(fs.readFileSync(domainsPath, 'utf-8'));
        for (const [domKey, domData] of Object.entries(domains)) {
          const domNorm = domData.name_norm || stripAccents(domData.name || '');
          const kwNorm = (domData.keywords_norm || []).join(' ');
          if (domNorm.includes(qNorm) || kwNorm.includes(qNorm)) {
            if (results.filter(r => r.type.includes('Khối Ngành')).length < 3) {
              results.push({
                type: 'Khối Ngành & Hướng Nghiệp Holland',
                title: domData.name,
                detail: `Mã Holland: ${domData.holland_code || 'N/A'} | Từ khóa: ${(domData.keywords || []).slice(0, 6).join(', ')}`,
                raw: domData
              });
            }
          }
        }
      } catch (err) {}
    }

    res.json({ query: rawQ, total: results.length, results });
  } catch (error) {
    console.error('RAG test search error:', error);
    res.status(500).json({ message: 'Lỗi tra cứu RAG: ' + error.message });
  }
});

module.exports = router;
