"""
Thu nhập việc làm của sinh viên (D5): thực tập, bán thời gian, thời vụ, từ chính bộ tin tuyển dụng đã có
(cột job_type do trang tuyển dụng gắn), theo vùng. Phục vụ quyết định "đi làm thêm" của sinh viên.

Kết quả: data/knowledge/student_jobs.json
  {category: {region: {p25, p50, p75, n}}, ...} đơn vị triệu đồng/tháng (lương rao tuyển, không phải thực nhận)

Chạy: python -I data_pipeline/build_student_jobs.py --parquet ../data.parquet
"""

import argparse
import json
import os
import re
import sys

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "ml"))
import features as F  # noqa: E402

if sys.platform.startswith("win"):
    sys.stdout.reconfigure(encoding="utf-8")

SERVER = os.path.abspath(os.path.join(HERE, ".."))
CATEGORIES = {
    "intern": {"label": "Thực tập", "job_types": ["Thực tập"]},
    "part_time": {"label": "Bán thời gian / theo ca", "job_types": ["Bán thời gian", "Theo ca", "Toàn thời gian, Bán thời gian"]},
    "seasonal": {"label": "Thời vụ", "job_types": ["Thời vụ"]},
}
REGIONS = {
    "hanoi": re.compile(r"hà nội|ha noi|hanoi", re.I),
    "hcm": re.compile(r"hồ chí minh|ho chi minh|hcm|tp\.? ?hcm|sài gòn|thủ đức", re.I),
    "danang": re.compile(r"đà nẵng|da nang", re.I),
}


def quantiles(values):
    if len(values) < 30:  # quá ít tin thì không công bố số
        return None
    p25, p50, p75 = np.percentile(values, [25, 50, 75])
    return {"p25": round(float(p25), 1), "p50": round(float(p50), 1), "p75": round(float(p75), 1), "n": int(len(values))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--parquet", default=os.path.join(SERVER, "..", "data.parquet"))
    ap.add_argument("--min-year", type=int, default=2024)
    args = ap.parse_args()

    df = pd.read_parquet(args.parquet, columns=["job_title", "company_name", "salary", "location", "job_type", "year"])
    df = df[df["year"] >= args.min_year]
    parsed = df["salary"].map(F.parse_salary_million)
    df = df[parsed.notna()].copy()
    df["mid"] = [(p[0] + p[1]) / 2 for p in parsed[parsed.notna()]]
    df = df.drop_duplicates(["job_title", "company_name", "salary"])
    df = df[(df["mid"] >= 1) & (df["mid"] <= 60)]  # loại lỗi nhập (lương theo giờ/ngày hoặc số vô lý)

    out = {
        "source": {"publisher": "Tin tuyển dụng tổng hợp", "tier": "C", "years": [args.min_year, int(df["year"].max())],
                   "note": "Lương rao tuyển theo tháng của tin gắn loại hình thực tập/bán thời gian/thời vụ; không phải thu nhập thực nhận"},
        "categories": {},
    }
    for key, cfg in CATEGORIES.items():
        sub = df[df["job_type"].isin(cfg["job_types"])]
        entry = {"label": cfg["label"], "all": quantiles(sub["mid"].values)}
        for rkey, rre in REGIONS.items():
            entry[rkey] = quantiles(sub[sub["location"].fillna("").str.contains(rre)]["mid"].values)
        out["categories"][key] = entry
        print(key, json.dumps(entry, ensure_ascii=False))
    path = os.path.join(SERVER, "data", "knowledge", "student_jobs.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print("->", path)


if __name__ == "__main__":
    main()
