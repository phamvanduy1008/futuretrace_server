"""
Thống kê thị trường tuyển dụng theo ngành (thay market_intelligence.json cũ: 23/28 ngành là số giữ chỗ
8/13/18 vì parser cũ chỉ đọc được ~2% chuỗi lương).

Dùng chung bộ parse lương và chuẩn hóa với FT-Salary (ml/features.py). Kết quả:
data/knowledge/market_facts.json: theo đoạn ngành (khớp vocab FT-Salary), toàn bộ và riêng người mới
tốt nghiệp (kinh nghiệm <= 1 năm, yêu cầu Cao đẳng/Đại học), cộng phân bố yêu cầu bằng cấp.

Chạy: python -I data_pipeline/build_market_facts.py --parquet ../data.parquet
"""

import argparse
import json
import os
import sys
from collections import defaultdict

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "ml"))
import features as F  # noqa: E402

if sys.platform.startswith("win"):
    sys.stdout.reconfigure(encoding="utf-8")

SERVER = os.path.abspath(os.path.join(HERE, ".."))
EDU_LABEL = {4.0: "dai_hoc", 3.0: "cao_dang", 2.0: "trung_cap", 1.5: "chung_chi", 1.0: "thpt", 0.0: "khong_yeu_cau"}


def quantiles(values):
    if len(values) == 0:
        return None
    p25, p50, p75 = np.percentile(values, [25, 50, 75])
    return {"p25": round(float(p25), 1), "p50": round(float(p50), 1), "p75": round(float(p75), 1), "n": int(len(values))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--parquet", default=os.path.join(SERVER, "..", "data.parquet"))
    ap.add_argument("--min-year", type=int, default=2024, help="chỉ dùng tin gần đây cho mức lương hiện hành")
    args = ap.parse_args()

    cols = ["job_title", "company_name", "salary", "job_industry", "experience_level", "education_level", "year"]
    df = pd.read_parquet(args.parquet, columns=cols)
    df = df[df["year"] >= args.min_year]
    parsed = df["salary"].map(F.parse_salary_million)
    df = df[parsed.notna()].copy()
    df["mid"] = [(p[0] + p[1]) / 2 for p in parsed[parsed.notna()]]
    df = df.drop_duplicates(["job_title", "company_name", "salary"])
    df["exp"] = df["experience_level"].map(F.parse_experience)
    df["edu"] = df["education_level"].map(F.parse_education)

    with open(os.path.join(SERVER, "data", "ml", "salary_model.json"), encoding="utf-8") as f:
        vocab = set(json.load(f)["vocab"]["industry_segments"])

    rows_by_seg = defaultdict(list)
    for i, v in enumerate(df["job_industry"].values):
        for s in F.industry_segments(v):
            if s in vocab:
                rows_by_seg[s].append(i)

    mids = df["mid"].values
    exps = df["exp"].values
    edus = df["edu"].values
    out = {}
    for seg, idx in rows_by_seg.items():
        idx = np.array(idx)
        fresher = np.array([(exps[i] is not None and exps[i] <= 1) and (edus[i] is not None and edus[i] >= 3) for i in idx])
        edu_counts = defaultdict(int)
        for i in idx:
            if edus[i] is not None:
                edu_counts[EDU_LABEL.get(edus[i], "khac")] += 1
        with_req = sum(c for k, c in edu_counts.items() if k != "khong_yeu_cau")
        out[seg] = {
            "postings": int(len(idx)),
            "salary_million_all": quantiles(mids[idx]),
            "salary_million_fresher_graduate": quantiles(mids[idx][fresher]) if fresher.sum() >= 30 else None,
            "education_requirement_share_among_stated": {
                k: round(c / with_req * 100, 1) for k, c in edu_counts.items() if k != "khong_yeu_cau" and with_req
            },
            "no_requirement_share_percent": round(edu_counts.get("khong_yeu_cau", 0) / len(idx) * 100, 1),
        }

    payload = {
        "source": {
            "title": "Tin tuyển dụng tổng hợp (data.parquet)",
            "tier": "C",
            "years": [args.min_year, int(df["year"].max())],
            "postings_used": int(len(df)),
            "caveat": "Lương rao trong tin tuyển dụng (điểm giữa khoảng lương), không phải lương thực nhận; nguồn trộn nhiều trang tuyển dụng",
        },
        "industries": out,
    }
    with open(os.path.join(SERVER, "data", "knowledge", "market_facts.json"), "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    for seg in ("it phan mem", "ke toan", "marketing", "duoc pham", "xay dung"):
        if seg in out:
            print(seg, out[seg]["postings"], out[seg]["salary_million_all"], out[seg]["salary_million_fresher_graduate"])
    print("postings used", len(df))


if __name__ == "__main__":
    main()
