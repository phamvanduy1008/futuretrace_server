"""
Dựng Knowledge Layer v2 (data/knowledge/*.json) từ dữ liệu gốc, thay cho scripts/build_rag_knowledge.py.

Nguyên tắc:
  - Mỗi bản ghi tham chiếu một `source_id` trong sources.json (publisher, url, tier, ngày thu thập,
    cách trích xuất, đã xác minh hay chưa).
  - Không điền số mặc định: thiếu dữ liệu thì để null; giá trị ngoài miền hợp lệ bị loại và ghi vào
    quality_report.json kèm lý do.
  - Không dùng số nhập tay không có nguồn (danh sách PREMIER_UNIVERSITIES cũ bị bỏ).

Chạy: python -I data_pipeline/build_knowledge.py
"""

import hashlib
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import date

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "ml"))
import crosswalk as CW  # noqa: E402
from features import norm_text  # noqa: E402

if sys.platform.startswith("win"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
SERVER = os.path.abspath(os.path.join(HERE, ".."))
OUT = os.path.join(SERVER, "data", "knowledge")

SOURCES = {
    "src_cutoff_2025_scrape": {
        "title": "Điểm chuẩn đại học 2025 (phương thức điểm thi THPT), bảng tổng hợp đã thu thập",
        "publisher": "Tổng hợp từ trang tra cứu điểm chuẩn (nghi là diemthi.vnexpress.net theo crawl_data.py)",
        "url": "https://diemthi.vnexpress.net/tra-cuu-dai-hoc",
        "tier": "B",
        "retrieved_at": "2026-07-14",
        "year_note": "Năm 2025 được suy ra từ tổ hợp X01-X98 (Bộ GD&ĐT áp dụng từ 2025); file gốc không có cột năm",
        "extraction": "scraper",
        "verified": False,
    },
    "src_numbeo_2026": {
        "title": "Numbeo Cost of Living (Hà Nội, TP.HCM, Đà Nẵng)",
        "publisher": "Numbeo",
        "url": "https://www.numbeo.com/cost-of-living/",
        "tier": "B",
        "retrieved_at": "2026-07",
        "extraction": "scraper",
        "verified": False,
        "caveat": "Phản ánh mức chi của người đi làm/người nước ngoài; ngân sách sinh viên là ước tính suy ra",
    },
    "src_crosswalk_draft": {
        "title": "Bảng nối ngành đào tạo - nhóm nghề tuyển dụng (FutureTrace)",
        "publisher": "FutureTrace",
        "url": None,
        "tier": "curated",
        "retrieved_at": str(date.today()),
        "extraction": "manual",
        "verified": CW.REVIEW_STATUS.startswith("reviewed_"),
    },
}

MOET_CODE = re.compile(r"^7\d{6}")
COMBO = re.compile(r"[A-Z]\d{2}")


def slug(text):
    return norm_text(text).replace(" ", "-")


def parse_vnd(raw):
    """'36,200,000' / '36.200.000' / 36200000 -> 36200000 ; rỗng -> None"""
    if raw is None or (isinstance(raw, float) and pd.isna(raw)):
        return None
    digits = re.sub(r"[^\d]", "", str(raw))
    return int(digits) if digits else None


def load_legacy_aliases():
    path = os.path.join(SERVER, "data", "rag", "admissions_index.json")
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        return {norm_text(s["school_name"]): s.get("aliases", []) for s in json.load(f)}


CUTOFF_DIR = os.path.join(ROOT, "data_sources", "cutoffs")


def iter_raw_rows():
    """Các dòng điểm chuẩn thô: bảng tổng hợp 2025 + mọi file CSV nhiều năm trong data_sources/cutoffs."""
    df = pd.read_excel(os.path.join(ROOT, "diem_chuan_tat_ca_cac_truong.xlsx"))
    for row in df.itertuples(index=False):
        yield {
            "school_name": row[0], "province": row[1], "major_name": row[3], "program_code": row[4],
            "cutoff": row[5], "subject_groups": row[6], "tuition_vnd": row[7], "year": 2025, "method": "THPT",
            "scale": 30, "source_id": "src_cutoff_2025_scrape", "tier": "B", "verified": False,
        }
    if not os.path.isdir(CUTOFF_DIR):
        return
    for name in sorted(os.listdir(CUTOFF_DIR)):
        if not name.endswith(".csv") or name.startswith("_"):
            continue
        csv = pd.read_csv(os.path.join(CUTOFF_DIR, name), dtype=str).fillna("")
        for r in csv.to_dict("records"):
            url = r.get("source_url", "").strip()
            sid = "src_" + hashlib.sha1((url or name).encode("utf-8")).hexdigest()[:10]
            if sid not in SOURCES:
                SOURCES[sid] = {
                    "title": f"Điểm chuẩn (file {name})", "publisher": r.get("publisher") or "Chưa ghi",
                    "url": url or None, "tier": (r.get("tier") or "B").strip(), "retrieved_at": r.get("retrieved_at"),
                    "extraction": "manual", "verified": str(r.get("verified", "")).lower() in ("true", "1", "x", "yes"),
                }
            yield {
                "school_name": r.get("school_name"), "province": r.get("province"), "major_name": r.get("major_name"),
                "program_code": r.get("program_code") or r.get("major_code"), "cutoff": r.get("cutoff"),
                "subject_groups": r.get("subject_groups", "").replace(";", ","), "tuition_vnd": r.get("tuition_vnd"),
                "tuition_unit": r.get("tuition_unit") or None, "year": r.get("year"),
                "method": (r.get("method") or "THPT").strip().upper(), "scale": r.get("scale") or 30,
                "quota": r.get("quota"), "source_id": sid, "tier": SOURCES[sid]["tier"], "verified": SOURCES[sid]["verified"],
            }


def build_admissions(issues):
    legacy_aliases = load_legacy_aliases()
    schools = {}
    rows = []
    seen = set()

    for r in iter_raw_rows():
        school_name = str(r["school_name"] or "").strip()
        major_name = str(r["major_name"] or "").strip()
        raw_code = str(r["program_code"] or "").strip()
        record_ref = f"{school_name} | {major_name} | {raw_code} | {r['year']}"
        if not school_name or not raw_code:
            issues.append({"type": "missing_school_or_code", "record": record_ref})
            continue
        try:
            year = int(float(r["year"]))
            cutoff = float(str(r["cutoff"]).replace(",", "."))
            scale = int(float(r["scale"] or 30))
        except (TypeError, ValueError):
            issues.append({"type": "not_numeric", "record": record_ref, "value": str(r["cutoff"])})
            continue
        if scale != 30 or not (10 <= cutoff <= 30):
            # Thang 40 có nhân hệ số, ĐGNL (thang 150/1200)...: chưa quy đổi được về thang 30 nên không trộn chung.
            # 151 trong bảng tổng hợp là lỗi nhập liệu. Không đoán, loại khỏi dữ liệu dùng được.
            issues.append({"type": "cutoff_out_of_30_scale", "record": record_ref, "value": cutoff})
            continue

        school_id = slug(school_name)
        if school_id not in schools:
            aliases = set(legacy_aliases.get(norm_text(school_name), []))
            aliases.add(school_name)
            schools[school_id] = {
                "id": school_id, "name": school_name, "province": str(r["province"] or "").strip(),
                "aliases": sorted(aliases), "source_id": r["source_id"],
            }

        combos = sorted(set(COMBO.findall(str(r["subject_groups"]))))
        key = (school_id, raw_code, r["method"], tuple(combos), year, cutoff)
        if key in seen:
            issues.append({"type": "duplicate_row", "record": record_ref})
            continue
        seen.add(key)

        std = MOET_CODE.match(raw_code)
        major_code = CW.CODE_FIXES.get(std.group(0), std.group(0)) if std else None
        tuition = parse_vnd(r.get("tuition_vnd"))
        rows.append({
            "school_id": school_id, "major_code": major_code, "program_code": raw_code, "major_name": major_name,
            "year": year, "method": r["method"], "subject_groups": combos, "cutoff": round(cutoff, 2), "scale": 30,
            "tuition_vnd": tuition, "tuition_unit": (r.get("tuition_unit") or "unknown") if tuition else None,
            "source_id": r["source_id"], "tier": r["tier"], "verified": r["verified"],
        })

    # Gom theo (trường, mã chương trình, phương thức): năm mới nhất để hiển thị, các năm khác thành lịch sử.
    # Cùng năm có cả nguồn chính thức (tier A / đã xác minh) và nguồn tổng hợp: chỉ giữ nguồn chính thức.
    groups = defaultdict(list)
    for row in rows:
        groups[(row["school_id"], row["program_code"], row["method"])].append(row)

    programs, program_ids = [], {}
    for (school_id, raw_code, method), grp in groups.items():
        by_year = defaultdict(list)
        for row in grp:
            by_year[row["year"]].append(row)
        for y, yrows in by_year.items():
            official = [x for x in yrows if x["tier"] == "A" or x["verified"]]
            by_year[y] = official or yrows
        history = [{
            "year": y,
            "cutoff": min(x["cutoff"] for x in by_year[y]),
            "n_combos": len(by_year[y]),
            "source_id": by_year[y][0]["source_id"],
        } for y in sorted(by_year)]
        latest = max(by_year)

        for row in by_year[latest]:
            cw = CW.lookup(row["major_code"], row["major_name"])
            if cw is None:
                issues.append({"type": "no_crosswalk", "record": f"{row['major_name']} | {raw_code}"})
            program_id = f"{school_id}:{raw_code}:{'-'.join(row['subject_groups']) or 'na'}" + ("" if method == "THPT" else f":{method}")
            if program_id in program_ids:
                # Cùng trường + mã + tổ hợp nhưng điểm khác nhau (vd. chương trình con không ghi rõ)
                issues.append({"type": "conflicting_cutoff_same_program", "record": program_id, "value": row["cutoff"]})
                program_ids[program_id] += 1
                program_id = f"{program_id}#{program_ids[program_id]}"
            else:
                program_ids[program_id] = 1
            programs.append({
                "id": program_id,
                "school_id": school_id,
                "major_code": row["major_code"],
                "program_code": raw_code,
                "major_name": row["major_name"],
                "year": latest,
                "method": method,
                "subject_groups": row["subject_groups"],
                "cutoff": row["cutoff"],
                "scale": 30,
                "is_floor_score": row["cutoff"] <= 15.0,
                "tuition_vnd": row["tuition_vnd"],
                "tuition_unit": row["tuition_unit"],
                "occupation": {k: cw[k] for k in ("industry", "role", "riasec", "fit", "domain", "match_level")} if cw else None,
                "source_id": row["source_id"],
                # Lịch sử điểm chuẩn (thấp nhất giữa các tổ hợp mỗi năm) cho mô hình FT-Admit
                "history": history,
                "history_basis": "min_across_subject_groups",
            })

    return list(schools.values()), programs


def build_living_costs():
    path = os.path.join(SERVER, "data", "rag", "living_costs_index.json")
    with open(path, encoding="utf-8") as f:
        idx = json.load(f)
    cities = {}
    for v in idx.values():
        cities[v["city"]] = {
            "city": v["city"],
            "student_budget_million_per_month": v["estimated_monthly_student_million"],
            "method": "thuê 1PN ngoài trung tâm / 3 + 60 bữa x 60% giá bữa bình dân + điện nước, internet / 3 + 0,8tr đi lại",
            "source_id": "src_numbeo_2026",
        }
    return list(cities.values())


def main():
    os.makedirs(OUT, exist_ok=True)
    issues = []
    schools, programs = build_admissions(issues)
    living = build_living_costs()

    crosswalk = {
        "review_status": CW.REVIEW_STATUS,
        "rules": {k: {**v, "domain": (CW.lookup(k) or {}).get("domain")} for k, v in CW.RULES.items()},
        "code_fixes": CW.CODE_FIXES,
        "source_id": "src_crosswalk_draft",
    }

    mf_path = os.path.join(OUT, "market_facts.json")
    cw_errors = []
    if os.path.exists(mf_path):
        with open(mf_path, encoding="utf-8") as f:
            cw_errors = CW.validate(json.load(f)["industries"].keys())
    for e in cw_errors:
        issues.append({"type": "crosswalk_invalid", "record": e})

    by_type = Counter(i["type"] for i in issues)
    n_with_tuition = sum(1 for p in programs if p["tuition_vnd"])
    region_counts = Counter(s["province"] for s in schools)
    report = {
        "built_at": str(date.today()),
        "schools": len(schools),
        "programs": len(programs),
        "programs_with_tuition": n_with_tuition,
        "programs_with_crosswalk": sum(1 for p in programs if p["occupation"]),
        "crosswalk_fit": dict(Counter((p["occupation"] or {}).get("fit", "missing") for p in programs)),
        "crosswalk_review_status": CW.REVIEW_STATUS,
        "crosswalk_errors": cw_errors,
        "programs_floor_score": sum(1 for p in programs if p["is_floor_score"]),
        "years_covered": sorted({h["year"] for p in programs for h in p["history"]}),
        "programs_with_multi_year_history": sum(1 for p in programs if len(p["history"]) >= 2),
        "methods_covered": sorted({p["method"] for p in programs}),
        "verified_share": 0.0,
        "issues_by_type": dict(by_type),
        "issues_sample": issues[:40],
        "top_provinces": dict(region_counts.most_common(10)),
        "known_gaps": [
            "Chỉ có 1 năm điểm chuẩn (2025) và 1 phương thức (điểm thi THPT): chưa đủ cho mô hình xác suất trúng tuyển",
            "Thiếu nhiều trường lớn: HUST, NEU, FTU Hà Nội, UEH, HCMUT, HCMUS, ĐHQG HN, HMU, UMP, ĐH Cần Thơ, TDTU...",
            "Học phí chỉ có ở một phần nhỏ chương trình và chưa rõ đơn vị (năm hay học kỳ)",
            "Chưa có tỷ lệ sinh viên có việc làm theo ngành/trường",
            "Nguồn bảng điểm chuẩn chưa được đối chiếu với thông báo chính thức của trường",
        ],
    }

    for name, payload in (("schools.json", schools), ("programs.json", programs),
                          ("living_costs.json", living), ("crosswalk.json", crosswalk),
                          ("sources.json", SOURCES), ("quality_report.json", report)):
        with open(os.path.join(OUT, name), "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=1 if name != "programs.json" else None)
    print(json.dumps({k: v for k, v in report.items() if k not in ("issues_sample",)}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
