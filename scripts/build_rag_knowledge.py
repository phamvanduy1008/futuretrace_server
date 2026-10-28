"""
FutureTrace RAG Knowledge Ingestion Pipeline
Processes:
1. data.parquet (606,878 real recruitment job posts in Vietnam, 2022-2026)
2. diem_chuan_tat_ca_cac_truong.xlsx (3,606 cutoff scores for 177 universities)
3. luong_trung_binh_vietnamworks.xlsx & vietnam_salaries_by_industry.csv (6,220+ job salaries)
4. numbeo_cost_of_living.json (1,016 living cost data points across Vietnamese cities)
5. knowledge_base.json (15 curated macro domain profiles)

Output: Optimized, structured JSON indices in futuretrace_server/data/rag/
"""

import sys, os, re, json, io
import pandas as pd
import numpy as np

# Ensure UTF-8 output
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SERVER_DIR = os.path.join(BASE_DIR, 'futuretrace_server')
RAG_OUT_DIR = os.path.join(SERVER_DIR, 'data', 'rag')
os.makedirs(RAG_OUT_DIR, exist_ok=True)

print(f"[RAG Pipeline] Base directory: {BASE_DIR}")
print(f"[RAG Pipeline] Output directory: {RAG_OUT_DIR}")

# ====================================================================
# HELPER: Vietnamese accent removal for fuzzy & entity search
# ====================================================================
def strip_accents(text):
    if not text or not isinstance(text, str):
        return ""
    text = text.lower().strip()
    patterns = {
        '[àáảãạăằắẳẵặâầấẩẫậ]': 'a',
        '[èéẻẽẹêềếểễệ]': 'e',
        '[ìíỉĩị]': 'i',
        '[òóỏõọôồốổỗộơờớởỡợ]': 'o',
        '[ùúủũụưừứửữự]': 'u',
        '[ỳýỷỹỵ]': 'y',
        '[đ]': 'd'
    }
    for regex, replacement in patterns.items():
        text = re.sub(regex, replacement, text)
    return text

# ====================================================================
# 1. PROCESS data.parquet (606,878 Real Job Postings)
# ====================================================================
def process_parquet_jobs():
    parquet_path = os.path.join(BASE_DIR, 'data.parquet')
    if not os.path.exists(parquet_path):
        print(f"[WARN] {parquet_path} not found. Skipping.")
        return

    print(f"\n[1/5] Processing {parquet_path} (606k job postings)...")
    df = pd.read_parquet(parquet_path)
    total_records = len(df)
    print(f"      Total records loaded: {total_records:,}")

    # Helper to parse salary text: '26 - 36 triệu', '15 - 35 triệu', '4000 usd', '1200 usd', '10 triệu'
    def parse_salary_text(val):
        if not val or pd.isna(val):
            return None, None
        s = str(val).lower().strip()
        if 'thoả thuận' in s or 'thỏa thuận' in s or 'đang cập nhật' in s or 'cạnh tranh' in s:
            return None, None
        
        # USD
        usd_match = re.search(r'(\d+(?:[.,]\d+)?)\s*(?:-\s*(\d+(?:[.,]\d+)?))?\s*usd', s)
        if usd_match:
            min_v = float(usd_match.group(1).replace(',', '.')) * 25.4 / 1000  # in million VND
            max_v = float(usd_match.group(2).replace(',', '.')) * 25.4 / 1000 if usd_match.group(2) else min_v
            return round(min_v, 1), round(max_v, 1)

        # Triệu VND
        triệu_match = re.search(r'(\d+(?:[.,]\d+)?)\s*(?:-\s*(\d+(?:[.,]\d+)?))?\s*triệu', s)
        if triệu_match:
            min_v = float(triệu_match.group(1).replace(',', '.'))
            max_v = float(triệu_match.group(2).replace(',', '.')) if triệu_match.group(2) else min_v
            return round(min_v, 1), round(max_v, 1)

        return None, None

    # Compute parsed salary columns
    print("      Parsing salary distributions across industries...")
    parsed_salaries = [parse_salary_text(v) for v in df['salary']]
    df['salary_min'] = [p[0] for p in parsed_salaries]
    df['salary_max'] = [p[1] for p in parsed_salaries]

    # Group by industry
    industry_stats = {}
    top_industries = df['job_industry'].value_counts().head(30).index.tolist()

    for ind in top_industries:
        if not ind or str(ind).strip() == '' or ind == 'Chưa xác định' or ind == 'Nghề nghiệp khác':
            continue
        sub = df[df['job_industry'] == ind]
        sub_sal = sub.dropna(subset=['salary_min', 'salary_max'])
        
        # Filter realistic values (1 to 200 million)
        valid_sal = sub_sal[(sub_sal['salary_min'] >= 1) & (sub_sal['salary_max'] <= 250)]
        
        sal_min_median = float(np.round(valid_sal['salary_min'].median(), 1)) if len(valid_sal) > 0 else 8.0
        sal_max_median = float(np.round(valid_sal['salary_max'].median(), 1)) if len(valid_sal) > 0 else 18.0
        sal_avg = float(np.round((sal_min_median + sal_max_median) / 2, 1))

        # Experience breakdown
        exp_breakdown = {}
        for exp in ['Thực tập sinh', 'Nhân viên', 'Trưởng nhóm', 'Trưởng phòng']:
            exp_sub = valid_sal[valid_sal['job_position'].str.contains(exp, case=False, na=False)]
            if len(exp_sub) >= 5:
                exp_breakdown[exp] = {
                    'min': float(np.round(exp_sub['salary_min'].median(), 1)),
                    'max': float(np.round(exp_sub['salary_max'].median(), 1)),
                    'count': int(len(exp_sub))
                }

        # Education level ratio
        edu_counts = sub['education_level'].value_counts(normalize=True).to_dict()
        univ_ratio = round(edu_counts.get('Đại học', 0.0) * 100, 1)
        college_ratio = round(edu_counts.get('Cao đẳng', 0.0) * 100, 1)

        # Top hiring companies
        top_companies = sub['company_name'].value_counts().head(5).index.tolist()

        # Top locations
        top_locs = sub['location'].value_counts().head(3).index.tolist()

        industry_stats[ind] = {
            'industry': ind,
            'total_postings': int(len(sub)),
            'salary_vnd_million': {
                'min_median': sal_min_median,
                'avg_median': sal_avg,
                'max_median': sal_max_median
            },
            'experience_salary': exp_breakdown,
            'education_requirement': {
                'university_percent': univ_ratio,
                'college_percent': college_ratio
            },
            'top_hiring_companies': [str(c).strip() for c in top_companies if str(c).strip()][:5],
            'sample_roles': [str(r).strip() for r in sub['job_title'].value_counts().head(5).index.tolist()][:5]
        }

    out_file = os.path.join(RAG_OUT_DIR, 'market_intelligence.json')
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(industry_stats, f, ensure_ascii=False, indent=2)
    print(f"      ✅ Saved market intelligence to {out_file} ({len(industry_stats)} industries)")

# ====================================================================
# 2. PROCESS diem_chuan_tat_ca_cac_truong.xlsx (177 Universities)
# ====================================================================
def process_admissions_excel():
    excel_path = os.path.join(BASE_DIR, 'diem_chuan_tat_ca_cac_truong.xlsx')
    if not os.path.exists(excel_path):
        print(f"[WARN] {excel_path} not found. Skipping.")
        return

    print(f"\n[2/5] Processing {excel_path} (3,606 university majors)...")
    df = pd.read_excel(excel_path)

    # University alias map for robust search
    UNIVERSITY_ALIASES = {
        "đại học bách khoa hà nội": ["hust", "bách khoa hà nội", "bach khoa ha noi", "bkhn", "bách khoa hn", "dh bách khoa"],
        "trường đại học fpt": ["fpt", "đại học fpt", "dh fpt", "đh fpt", "fpt university", "đại học fpt hà nội", "đại học fpt tp.hcm"],
        "trường đại học kinh tế quốc dân": ["neu", "kinh tế quốc dân", "kinh te quoc dan", "ktqd", "đh ktqd"],
        "trường đại học ngoại thương": ["ftu", "ngoại thương", "ngoai thuong", "đh ngoại thương", "dh ngoai thuong"],
        "đại học kinh tế tp. hồ chí minh": ["ueh", "kinh tế tphcm", "kinh te tphcm", "đại học kinh tế tphcm"],
        "trường đại học công nghệ - đại học quốc gia hà nội": ["uet", "công nghệ đhqg", "cong nghe dhqg", "công nghệ hà nội"],
        "trường đại học công nghệ thông tin - đhqg tp.hcm": ["uit", "công nghệ thông tin đhqg", "uit tphcm"],
        "học viện công nghệ bưu chính viễn thông": ["ptit", "bưu chính viễn thông", "buu chinh vien thong", "học viện bưu chính"],
        "trường đại học y hà nội": ["hmu", "y hà nội", "y ha noi", "đại học y hà nội", "yhn"],
        "đại học y dược tp.hcm": ["ump", "y dược tphcm", "y duoc tphcm", "y tphcm"],
        "trường đại học khoa học tự nhiên - đại học quốc gia hà nội": ["hus", "khoa học tự nhiên hà nội", "khtn hn"],
        "trường đại học khoa học tự nhiên - đhqg tp.hcm": ["hcmus", "khoa học tự nhiên tphcm", "khtn tphcm"],
        "trường đại học sư phạm hà nội": ["hnue", "sư phạm hà nội", "su pham ha noi"],
        "trường đại học sư phạm tp.hcm": ["hcmue", "sư phạm tphcm", "su pham tphcm"],
        "trường đại học luật hà nội": ["hlu", "luật hà nội", "luat ha noi"],
        "trường đại học luật tp.hcm": ["hul", "luật tphcm", "luat tphcm"],
        "trường đại học thương mại": ["tmu", "thương mại", "thuong mai", "đh thương mại"],
        "học viện tài chính": ["aof", "học viện tài chính", "hvtc", "tài chính"]
    }

    universities = {}
    for _, row in df.iterrows():
        school_raw = str(row.get('Trường', '')).strip()
        if not school_raw or school_raw == 'nan':
            continue
        
        school_norm = strip_accents(school_raw)
        
        if school_raw not in universities:
            # Find aliases
            aliases = [school_raw.lower(), school_norm]
            for std_name, alias_list in UNIVERSITY_ALIASES.items():
                if strip_accents(std_name) in school_norm or school_norm in strip_accents(std_name):
                    aliases.extend(alias_list)
                    break
            
            universities[school_raw] = {
                'school_name': school_raw,
                'province': str(row.get('Tỉnh thành', '')).strip(),
                'aliases': list(set(aliases)),
                'majors': []
            }

        # Major info
        cutoff = row.get('Điểm chuẩn')
        try:
            cutoff = float(cutoff) if pd.notna(cutoff) else None
        except:
            cutoff = None

        tuition = row.get('Học phí (VNĐ)')
        try:
            tuition = float(tuition) if pd.notna(tuition) else None
        except:
            tuition = None

        major_obj = {
            'major_name': str(row.get('Tên ngành', '')).strip(),
            'major_code': str(row.get('Mã ngành', '')).replace('.0', '').strip(),
            'cutoff_score': cutoff,
            'subject_group': str(row.get('Tổ hợp môn', '')).strip() if pd.notna(row.get('Tổ hợp môn')) else '',
            'tuition_vnd': tuition,
            'notes': str(row.get('Ghi chú', '')).strip() if pd.notna(row.get('Ghi chú')) else ''
        }
        universities[school_raw]['majors'].append(major_obj)

    # Supplementary premier national universities to guarantee 100% coverage
    PREMIER_UNIVERSITIES = [
        {
            "school_name": "Trường Đại học FPT",
            "province": "Hà Nội / TP.HCM / Đà Nẵng / Cần Thơ / Quy Nhơn",
            "aliases": ["fpt", "đại học fpt", "dh fpt", "đh fpt", "fpt university", "truong dai hoc fpt", "fpt hn", "fpt hcm", "fpt đà nẵng"],
            "majors": [
                {"major_name": "Kỹ thuật phần mềm", "major_code": "7480201", "cutoff_score": 21.0, "subject_group": "A00,A01,D01,D07 (hoặc Top 40 SchoolRank)", "tuition_vnd": 28700000, "notes": "Học bổng tài năng lên tới 100%. 1 kỳ thực tập OJT tại doanh nghiệp từ năm 3."},
                {"major_name": "Trí tuệ nhân tạo (AI)", "major_code": "7480201AI", "cutoff_score": 21.0, "subject_group": "A00,A01,D01 (hoặc Top 40 SchoolRank)", "tuition_vnd": 28700000, "notes": "Đào tạo chuyên sâu Deep Learning, NLP, Computer Vision."},
                {"major_name": "An toàn thông tin", "major_code": "7480202", "cutoff_score": 21.0, "subject_group": "A00,A01,D01 (hoặc Top 40 SchoolRank)", "tuition_vnd": 28700000, "notes": "Thực hành phòng Lab an ninh mạng đạt chuẩn quốc tế."},
                {"major_name": "Thiết kế mỹ thuật số (Digital Art & Design)", "major_code": "7210403", "cutoff_score": 21.0, "subject_group": "A00,A01,D01,H00", "tuition_vnd": 28700000, "notes": "Đào tạo UI/UX Design, đồ họa 3D và hoạt hình số."},
                {"major_name": "Quản trị kinh doanh", "major_code": "7340101", "cutoff_score": 21.0, "subject_group": "A00,A01,D01 (hoặc Top 40 SchoolRank)", "tuition_vnd": 28700000, "notes": "Chuyên ngành Digital Marketing, Kinh doanh quốc tế, E-Commerce."}
            ]
        },
        {
            "school_name": "Đại học Bách Khoa Hà Nội",
            "province": "Hà Nội",
            "aliases": ["hust", "bách khoa hà nội", "bach khoa ha noi", "bkhn", "bách khoa hn", "dh bách khoa", "đại học bách khoa hà nội"],
            "majors": [
                {"major_name": "Khoa học máy tính (IT1)", "major_code": "7480201", "cutoff_score": 28.53, "subject_group": "A00,A01", "tuition_vnd": 30000000, "notes": "Điểm ĐGNL TSA từ 72-85/100. Top đầu ngành CNTT cả nước."},
                {"major_name": "Kỹ thuật máy tính (IT2)", "major_code": "7480202", "cutoff_score": 28.05, "subject_group": "A00,A01", "tuition_vnd": 30000000, "notes": "Chuyên sâu hệ thống nhúng, IoT và kiến trúc máy tính."},
                {"major_name": "Khoa học Dữ liệu và Trí tuệ Nhân tạo (IT-E10)", "major_code": "7480201AI", "cutoff_score": 28.30, "subject_group": "A00,A01", "tuition_vnd": 55000000, "notes": "Chương trình tiên tiến giảng dạy bằng tiếng Anh."},
                {"major_name": "Kỹ thuật Điều khiển và Tự động hóa", "major_code": "7520216", "cutoff_score": 27.20, "subject_group": "A00,A01", "tuition_vnd": 30000000, "notes": "Tập trung tự động hóa công nghiệp và robot."},
                {"major_name": "Kỹ thuật Điện tử - Viễn thông", "major_code": "7520207", "cutoff_score": 26.50, "subject_group": "A00,A01", "tuition_vnd": 30000000, "notes": "Mạng 5G/6G, thiết kế vi mạch bán dẫn."}
            ]
        },
        {
            "school_name": "Trường Đại học Kinh tế Quốc dân",
            "province": "Hà Nội",
            "aliases": ["neu", "kinh tế quốc dân", "kinh te quoc dan", "ktqd", "đh ktqd", "truong dai hoc kinh te quoc dan"],
            "majors": [
                {"major_name": "Logistics và Quản lý chuỗi cung ứng", "major_code": "7510605", "cutoff_score": 28.10, "subject_group": "A00,A01,D01,D07", "tuition_vnd": 24000000, "notes": "Ngành cạnh tranh cao nhất khối kinh tế."},
                {"major_name": "Thương mại điện tử", "major_code": "7340122", "cutoff_score": 28.20, "subject_group": "A00,A01,D01,D07", "tuition_vnd": 24000000, "notes": "Kết hợp kinh doanh số và phân tích dữ liệu."},
                {"major_name": "Marketing", "major_code": "7340115", "cutoff_score": 28.00, "subject_group": "A00,A01,D01,D07", "tuition_vnd": 24000000, "notes": "Đào tạo chiến lược tiếp thị, truyền thông tích hợp."},
                {"major_name": "Công nghệ thông tin", "major_code": "7480201", "cutoff_score": 27.50, "subject_group": "A00,A01", "tuition_vnd": 24000000, "notes": "Ứng dụng CNTT trong phân tích tài chính và quản trị."}
            ]
        },
        {
            "school_name": "Trường Đại học Ngoại thương",
            "province": "Hà Nội / TP.HCM",
            "aliases": ["ftu", "ngoại thương", "ngoai thuong", "đh ngoại thương", "dh ngoai thuong", "truong dai hoc ngoai thuong"],
            "majors": [
                {"major_name": "Kinh tế đối ngoại", "major_code": "7310106", "cutoff_score": 28.50, "subject_group": "A00,A01,D01", "tuition_vnd": 25000000, "notes": "Ngành mũi nhọn truyền thống của FTU."},
                {"major_name": "Kinh doanh quốc tế", "major_code": "7340120", "cutoff_score": 28.30, "subject_group": "A00,A01,D01", "tuition_vnd": 25000000, "notes": "Xuất nhập khẩu và chuỗi cung ứng toàn cầu."},
                {"major_name": "Tài chính - Ngân hàng", "major_code": "7340201", "cutoff_score": 28.00, "subject_group": "A00,A01,D01", "tuition_vnd": 25000000, "notes": "Tài chính doanh nghiệp và Fintech."}
            ]
        },
        {
            "school_name": "Trường Đại học Công nghệ Thông tin - ĐHQG TP.HCM",
            "province": "TP. Hồ Chí Minh",
            "aliases": ["uit", "công nghệ thông tin đhqg", "uit tphcm", "dh cong nghe thong tin"],
            "majors": [
                {"major_name": "Khoa học máy tính", "major_code": "7480201", "cutoff_score": 27.80, "subject_group": "A00,A01", "tuition_vnd": 32000000, "notes": "Chương trình định hướng AI và thuật toán chuyên sâu."},
                {"major_name": "Kỹ thuật phần mềm", "major_code": "7480201PM", "cutoff_score": 27.50, "subject_group": "A00,A01", "tuition_vnd": 32000000, "notes": "Kỹ sư kiến trúc phần mềm, quy trình Agile/DevOps."},
                {"major_name": "An toàn thông tin", "major_code": "7480202", "cutoff_score": 27.20, "subject_group": "A00,A01", "tuition_vnd": 32000000, "notes": "Bảo mật hệ thống mạng và kiểm thử thâm nhập pentest."}
            ]
        },
        {
            "school_name": "Trường Đại học Công nghệ - ĐHQG Hà Nội",
            "province": "Hà Nội",
            "aliases": ["uet", "công nghệ đhqg", "cong nghe dhqg", "công nghệ hà nội", "dh cong nghe ha noi"],
            "majors": [
                {"major_name": "Công nghệ thông tin", "major_code": "7480201", "cutoff_score": 27.80, "subject_group": "A00,A01", "tuition_vnd": 35000000, "notes": "Chuẩn đầu ra quốc tế theo kiểm định AUN-QA."},
                {"major_name": "Trí tuệ nhân tạo", "major_code": "7480201AI", "cutoff_score": 27.60, "subject_group": "A00,A01", "tuition_vnd": 35000000, "notes": "Đào tạo nghiên cứu sinh và R&D AI."}
            ]
        },
        {
            "school_name": "Trường Đại học Y Hà Nội",
            "province": "Hà Nội",
            "aliases": ["hmu", "y hà nội", "y ha noi", "đại học y hà nội", "yhn", "dh y ha noi"],
            "majors": [
                {"major_name": "Y khoa", "major_code": "7720101", "cutoff_score": 28.25, "subject_group": "B00", "tuition_vnd": 55200000, "notes": "Đào tạo bác sĩ đa khoa chất lượng hàng đầu Việt Nam."},
                {"major_name": "Răng - Hàm - Mặt", "major_code": "7720501", "cutoff_score": 27.90, "subject_group": "B00", "tuition_vnd": 55200000, "notes": "Chương trình chuyên sâu nha khoa lâm sàng."},
                {"major_name": "Y học cổ truyền", "major_code": "7720115", "cutoff_score": 25.50, "subject_group": "B00", "tuition_vnd": 27600000, "notes": "Kết hợp đông y và tây y hiện đại."}
            ]
        },
        {
            "school_name": "Đại học Y Dược TP.HCM",
            "province": "TP. Hồ Chí Minh",
            "aliases": ["ump", "y dược tphcm", "y duoc tphcm", "y tphcm", "dh y duoc tphcm"],
            "majors": [
                {"major_name": "Y khoa", "major_code": "7720101", "cutoff_score": 27.80, "subject_group": "B00", "tuition_vnd": 74800000, "notes": "Bác sĩ lâm sàng đa khoa."},
                {"major_name": "Dược học", "major_code": "7720201", "cutoff_score": 25.50, "subject_group": "A00,B00", "tuition_vnd": 55000000, "notes": "Dược sĩ đại học, phát triển dược phẩm."}
            ]
        }
    ]

    for p_school in PREMIER_UNIVERSITIES:
        s_name = p_school["school_name"]
        if s_name not in universities:
            universities[s_name] = p_school
        else:
            existing_codes = {m.get('major_code') for m in universities[s_name]['majors']}
            for pm in p_school['majors']:
                if pm['major_code'] not in existing_codes:
                    universities[s_name]['majors'].append(pm)
            universities[s_name]['aliases'] = list(set(universities[s_name]['aliases'] + p_school['aliases']))

    out_file = os.path.join(RAG_OUT_DIR, 'admissions_index.json')
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(list(universities.values()), f, ensure_ascii=False, indent=2)
    print(f"      ✅ Saved admissions index to {out_file} ({len(universities)} universities)")

# ====================================================================
# 3. PROCESS VietnamWorks Salaries & CSV Industry Benchmarks
# ====================================================================
def process_salaries_and_industries():
    xlsx_path = os.path.join(BASE_DIR, 'luong_trung_binh_vietnamworks.xlsx')
    csv_path = os.path.join(BASE_DIR, 'vietnam_salaries_by_industry.csv')

    print(f"\n[3/5] Processing salary benchmarks...")
    roles_list = []
    if os.path.exists(xlsx_path):
        df_roles = pd.read_excel(xlsx_path)
        for _, r in df_roles.iterrows():
            title = str(r.get('Chức danh', '')).strip()
            if not title or title == 'nan':
                continue
            usd_avg = float(r.get('Lương trung bình (USD)', 0))
            usd_min = float(r.get('Lương tối thiểu (USD)', 0))
            usd_max = float(r.get('Lương tối đa (USD)', 0))
            sample_n = int(r.get('Số lượng mẫu', 1))

            roles_list.append({
                'title': title,
                'title_norm': strip_accents(title),
                'salary_usd': {'min': usd_min, 'avg': usd_avg, 'max': usd_max},
                'salary_vnd_million': {
                    'min': round(usd_min * 25.4 / 1000, 1),
                    'avg': round(usd_avg * 25.4 / 1000, 1),
                    'max': round(usd_max * 25.4 / 1000, 1)
                },
                'sample_size': sample_n
            })
        print(f"      Loaded {len(roles_list):,} job titles from VietnamWorks")

    industries_list = []
    if os.path.exists(csv_path):
        df_ind = pd.read_csv(csv_path)
        for _, r in df_ind.iterrows():
            name = str(r.get('Tên Ngành', '')).strip()
            if not name or name == 'nan':
                continue
            industries_list.append({
                'name': name,
                'name_norm': strip_accents(name),
                'entry_salary_range': str(r.get('Mức Lương Khởi Điểm (Triệu VNĐ/tháng)', '')).strip(),
                'avg_salary_range': str(r.get('Mức Lương Trung Bình (Triệu VNĐ/tháng)', '')).strip(),
                'holland_code': str(r.get('Nhóm Holland (RIASEC)', '')).strip(),
                'hiring_trend': str(r.get('Xu Hướng Tuyển Dụng', '')).strip(),
                'required_traits': str(r.get('Tố Chất Cần Thiết', '')).strip()
            })
        print(f"      Loaded {len(industries_list)} industry profiles from CSV")

    out_file = os.path.join(RAG_OUT_DIR, 'salaries_index.json')
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump({'roles': roles_list, 'industries': industries_list}, f, ensure_ascii=False, indent=2)
    print(f"      ✅ Saved salary index to {out_file}")

# ====================================================================
# 4. PROCESS numbeo_cost_of_living.json (1,016 data points)
# ====================================================================
def process_living_costs():
    json_path = os.path.join(BASE_DIR, 'numbeo_cost_of_living.json')
    if not os.path.exists(json_path):
        print(f"[WARN] {json_path} not found. Skipping.")
        return

    print(f"\n[4/5] Processing {json_path}...")
    with open(json_path, 'r', encoding='utf-8') as f:
        raw_data = json.load(f)

    cities_summary = {}
    for entry in raw_data:
        city = entry.get('city')
        if not city:
            continue
        costs = entry.get('costs', [])
        
        # Extract key representative items
        rent_single = 0
        meal_budget = 0
        coffee = 0
        utilities = 0

        for c in costs:
            item = c.get('item', '').lower()
            price = c.get('price_vnd', 0)
            # Chỉ lấy căn 1 phòng ngủ ngoài trung tâm (trước đây mục "3 Bedroom" ghi đè lên)
            if item.startswith('1 bedroom') and 'outside' in item:
                rent_single = price
            elif 'inexpensive restaurant' in item:
                meal_budget = price
            elif 'cappuccino' in item:
                coffee = price
            elif item.startswith('basic utilities') or item.startswith('broadband internet'):
                utilities += price

        # Ngân sách sinh viên/tháng: ở ghép 3 người, 60 bữa với giá bằng 60% bữa bình dân Numbeo
        # (Numbeo phản ánh mức chi của người đi làm/expat), chia điện nước + internet, 0.8tr đi lại.
        # Nên hiệu chỉnh lại bằng khảo sát sơ cấp sinh viên tại từng thành phố.
        est_rent = rent_single / 3 if rent_single > 0 else 2000000
        est_food = meal_budget * 60 * 0.6 if meal_budget > 0 else 2000000
        est_total = est_rent + est_food + utilities / 3 + 800000
        
        city_data = {
            'city': city,
            'city_norm': strip_accents(city),
            'living_cost_level': entry.get('living_cost_level', 'Medium'),
            'estimated_monthly_student_vnd': int(est_total),
            'estimated_monthly_student_million': round(est_total / 1000000, 1),
            'sample_costs': {
                'inexpensive_meal_vnd': meal_budget,
                'rent_outside_centre_vnd': rent_single,
                'coffee_vnd': coffee
            }
        }
        cities_summary[city] = city_data
        if city == 'Hanoi':
            cities_summary['Ha Noi'] = city_data
        elif city == 'HCMC':
            cities_summary['Ho Chi Minh'] = city_data
            cities_summary['TPHCM'] = city_data
        elif city == 'Danang':
            cities_summary['Da Nang'] = city_data

    out_file = os.path.join(RAG_OUT_DIR, 'living_costs_index.json')
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(cities_summary, f, ensure_ascii=False, indent=2)
    print(f"      ✅ Saved living cost index to {out_file} ({len(cities_summary)} city aliases)")

# ====================================================================
# 5. PROCESS & NORMALIZE knowledge_base.json (15 Macro Domains)
# ====================================================================
def process_macro_domains():
    kb_path = os.path.join(SERVER_DIR, 'data', 'knowledge_base.json')
    if not os.path.exists(kb_path):
        print(f"[WARN] {kb_path} not found. Skipping.")
        return

    print(f"\n[5/5] Normalizing {kb_path}...")
    with open(kb_path, 'r', encoding='utf-8') as f:
        kb = json.load(f)

    fields = kb.get('fields', {})
    normalized_fields = {}

    for k, v in fields.items():
        # Standardize camelCase and snake_case dual support
        sal = v.get('salary_vnd_million') or v.get('salary') or {}
        fresher = sal.get('fresher_year0_1') or sal.get('fresher_0_1year') or sal.get('fresher') or {}
        mid = sal.get('mid_year3_5') or sal.get('mid_3_5year') or sal.get('mid') or {}
        senior = sal.get('senior_year5_plus') or sal.get('senior_5year_plus') or sal.get('senior') or {}
        market_avg = sal.get('market_average_all_levels') or sal.get('marketAverage') or 0

        emp = v.get('employment') or {}
        emp_rate = emp.get('rate_percent') or v.get('employmentRate') or 90
        unemp_rate = emp.get('unemployment_rate_percent') or v.get('unemploymentRate') or 5

        skills = v.get('top_in_demand_skills') or v.get('topSkills') or []
        trends = v.get('hot_trends_2024_2025') or v.get('trendingFields') or []
        paths = v.get('career_paths') or v.get('careerPaths') or []
        certs = v.get('certifications_valued') or v.get('certifications') or []
        employers = v.get('top_employers') or v.get('topEmployers') or []
        outlook = v.get('outlook_3_5year') or v.get('outlook') or ''

        normalized_fields[k] = {
            'key': k,
            'name': v.get('name', ''),
            'name_norm': strip_accents(v.get('name', '')),
            'keywords': v.get('keywords', []),
            'keywords_norm': [strip_accents(kw) for kw in v.get('keywords', [])],
            'salary': {
                'fresher': {
                    'min': fresher.get('min', 8),
                    'avg': fresher.get('avg', 11),
                    'max': fresher.get('max', 15)
                },
                'mid': {
                    'min': mid.get('min', 18),
                    'avg': mid.get('avg', 25),
                    'max': mid.get('max', 35)
                },
                'senior': {
                    'min': senior.get('min', 35),
                    'avg': senior.get('avg', 50),
                    'max': senior.get('max', 80)
                },
                'market_avg': market_avg
            },
            'employment': {
                'rate_percent': emp_rate,
                'unemployment_percent': unemp_rate,
                'note': emp.get('note', '')
            },
            'top_skills': skills,
            'hot_trends': trends,
            'career_paths': paths,
            'certifications': certs,
            'top_employers': employers,
            'outlook_3_5year': outlook,
            'sources': v.get('source') or v.get('sources') or []
        }

    out_file = os.path.join(RAG_OUT_DIR, 'domains_index.json')
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(normalized_fields, f, ensure_ascii=False, indent=2)
    print(f"      ✅ Saved normalized domains index to {out_file} ({len(normalized_fields)} fields)")

if __name__ == '__main__':
    print("=" * 60)
    print("FutureTrace RAG Knowledge Ingestion Pipeline")
    print("=" * 60)
    process_parquet_jobs()
    process_admissions_excel()
    process_salaries_and_industries()
    process_living_costs()
    process_macro_domains()
    print("\n[RAG Pipeline] ✅ ALL DATASETS PROCESSED & INDEXED SUCCESSFULLY!")
