"""
Thu điểm chuẩn 2025-2026 (THPT + phương thức khác) và học phí/năm từ trang tra cứu điểm chuẩn VnExpress (tier B).

- robots.txt của diemthi.vnexpress.net cho phép (Allow: /). Crawler lịch sự: 1 yêu cầu/giây, User-Agent ghi rõ dự án,
  cache HTML/JSON tại data_sources/cutoffs/_cache/vnexpress/ (chạy lại không tải lại).
- Danh sách trường lấy từ sitemap; dữ liệu theo năm lấy từ endpoint mà chính trang dùng
  (/tra-cuu-dai-hoc/loadbenchmark/id/<id>/year/<năm>/...). Trang chỉ còn 2025-2026 (2024 trở về trước trả rỗng).

Kết quả (định dạng _TEMPLATE_cutoffs.csv, build_knowledge.py tự đọc):
  data_sources/cutoffs/vnexpress_2025_2026.csv          điểm THPT thang 30 + học phí/năm
  data_sources/cutoffs/_raw_other_methods_2025_2026.csv  điểm phương thức khác (học bạ, ĐGNL, TSA...) giữ nguyên chuỗi,
                                                          chưa quy đổi thang nên KHÔNG trộn vào dữ liệu dùng được

Chạy: python -I data_pipeline/collect_cutoffs_vnexpress.py [--limit 5]
"""

import argparse
import csv
import datetime as dt
import html as htmllib
import json
import os
import re
import sys
import time
import urllib.request

if sys.platform.startswith("win"):
    sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT_DIR = os.path.join(ROOT, "data_sources", "cutoffs")
CACHE = os.path.join(OUT_DIR, "_cache", "vnexpress")
BASE = "https://diemthi.vnexpress.net"
UA = "FutureTraceResearchBot/1.0 (do an tot nghiep FutureTrace; lien he nhathoang01012004@gmail.com)"
YEARS = [2025, 2026]
_last = [0.0]


def fetch(url, cache_name):
    path = os.path.join(CACHE, cache_name)
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return f.read()
    wait = 1.0 - (time.time() - _last[0])
    if wait > 0:
        time.sleep(wait)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "identity"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                text = r.read().decode("utf-8", errors="replace")
            break
        except Exception as e:  # mạng chập chờn: thử lại có giãn cách
            if attempt == 2:
                raise
            time.sleep(5 * (attempt + 1))
    _last[0] = time.time()
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return text


def clean(s):
    return re.sub(r"\s+", " ", htmllib.unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()


def school_list():
    xml = fetch(f"{BASE}/sitemap.xml", "sitemap.xml")
    urls = sorted(set(re.findall(r"<loc>(https://diemthi\.vnexpress\.net/tra-cuu-dai-hoc/[a-z0-9-]+-(\d+))</loc>", xml)))
    return [(u, sid) for u, sid in urls]


def school_info(url, sid):
    page = fetch(url, f"school_{sid}.html")
    name = re.search(r'"articleTitle":\s*"([^"]+)"', page)
    code_prov = re.search(r"Mã trường:\s*([^<\s]+)\s*</[^>]+>\s*<[^>]+>\s*([^<]+)<", page)
    m = re.search(r"Mã trường:\s*([A-Z0-9]+)(.{0,300})", page, re.S)
    province = ""
    if m:
        # Sau mã trường là thẻ chứa tỉnh/thành; HTML trang có thẻ không đóng nên cắt ở "<" đầu tiên còn sót
        after = re.sub(r"<[^>]*>", "|", m.group(2))
        parts = [p.strip() for p in re.split(r"[|<]", htmllib.unescape(after)) if p.strip()]
        province = parts[0] if parts else ""
    return {
        "id": sid,
        "name": htmllib.unescape(name.group(1)).strip() if name else "",
        "code": (code_prov.group(1) if code_prov else (m.group(1) if m else "")),
        "province": province,
    }


def parse_number(s):
    s = (s or "").strip().replace(",", ".")
    m = re.match(r"^\d+(\.\d+)?$", s)
    return float(s) if m else None


def parse_tuition(s):
    nums = [int(x.replace(".", "")) for x in re.findall(r"\d{1,3}(?:\.\d{3})+", s or "")]
    return nums[0] if nums else None


def benchmark_rows(sid, year):
    text = fetch(f"{BASE}/tra-cuu-dai-hoc/loadbenchmark/id/{sid}/year/{year}/sortby/1/block_name/-1", f"bm_{sid}_{year}.json")
    try:
        html = json.loads(text).get("html", "")
    except json.JSONDecodeError:
        return []
    out = []
    for row in re.findall(r'<tr class="university__benchmark[^"]*">(.*?)</tr>', html, re.S):
        tds = re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)
        if len(tds) < 4:
            continue
        name = clean((re.search(r"<a[^>]*>(.*?)</a>", tds[0], re.S) or [None, tds[0]])[1])
        code = clean((re.search(r'<span style="display: block;">(.*?)</span>', tds[0], re.S) or [None, ""])[1])
        out.append({
            "major_name": name, "program_code": code, "subject_groups": clean(tds[1]),
            "cutoff_thpt": clean(tds[2]), "other_methods": clean(tds[3]),
            "tuition": clean(tds[4]) if len(tds) > 4 else "",
        })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="chỉ lấy N trường đầu (chạy thử)")
    args = ap.parse_args()
    os.makedirs(CACHE, exist_ok=True)
    today = dt.date.today().isoformat()
    schools = school_list()
    if args.limit:
        schools = schools[: args.limit]
    print(f"{len(schools)} trường trong sitemap")

    main_rows, other_rows, stats = [], [], {"schools_with_data": 0, "rows": 0, "with_tuition": 0}
    for i, (url, sid) in enumerate(schools, 1):
        info = school_info(url, sid)
        got = False
        for year in YEARS:
            for r in benchmark_rows(sid, year):
                got = True
                combos = ";".join(re.findall(r"\b[A-Z]\d{2}\b|\bX\d{2}\b", r["subject_groups"]))
                cutoff = parse_number(r["cutoff_thpt"])
                tuition = parse_tuition(r["tuition"])
                base = {
                    "school_name": info["name"], "province": info["province"], "program_code": r["program_code"],
                    "major_code": r["program_code"] if re.fullmatch(r"\d{7}", r["program_code"] or "") else "",
                    "major_name": r["major_name"], "year": year, "subject_groups": combos,
                    "source_url": url, "publisher": "VnExpress - Tra cứu điểm chuẩn", "tier": "B",
                    "retrieved_at": today, "verified": "false",
                }
                if cutoff is not None:
                    main_rows.append({**base, "method": "THPT", "cutoff": cutoff, "scale": 30, "quota": "",
                                      "tuition_vnd": tuition or "", "tuition_unit": "năm" if tuition else ""})
                    stats["rows"] += 1
                    stats["with_tuition"] += bool(tuition)
                if r["other_methods"]:
                    other_rows.append({**base, "school_code": info["code"], "other_methods_raw": r["other_methods"]})
        stats["schools_with_data"] += got
        if i % 25 == 0:
            print(f"  {i}/{len(schools)} trường, {stats['rows']} dòng THPT")

    cols = ["school_name", "province", "program_code", "major_code", "major_name", "year", "method", "subject_groups",
            "cutoff", "scale", "quota", "tuition_vnd", "tuition_unit", "source_url", "publisher", "tier", "retrieved_at", "verified"]
    with open(os.path.join(OUT_DIR, "vnexpress_2025_2026.csv"), "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(main_rows)
    with open(os.path.join(OUT_DIR, "_raw_other_methods_2025_2026.csv"), "w", encoding="utf-8", newline="") as f:
        oc = ["school_name", "school_code", "province", "program_code", "major_name", "year", "subject_groups", "other_methods_raw", "source_url", "retrieved_at"]
        w = csv.DictWriter(f, fieldnames=oc, extrasaction="ignore")
        w.writeheader()
        w.writerows(other_rows)
    print(json.dumps(stats, ensure_ascii=False))


if __name__ == "__main__":
    main()
