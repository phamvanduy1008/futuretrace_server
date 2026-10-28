"""
FT-Salary: model dự báo phân phối lương (P25/P50/P75, triệu VND/tháng) cho FutureTrace.

Dữ liệu : data.parquet (606.878 tin tuyển dụng VN, 2022-2026)
Model   : XGBoost quantile regression trên log(lương), 3 model độc lập cho 3 phân vị
Đánh giá: temporal holdout - huấn luyện 2022-2025, kiểm tra trên toàn bộ tin năm 2026
          (mô phỏng đúng tình huống dự báo cho tương lai, không rò rỉ dữ liệu)
Export  : data/ml/salary_model.json (cây quyết định dạng mảng, chạy trực tiếp bằng Node.js)
          data/ml/market_trends.json (động lượng nhu cầu & tăng trưởng lương theo ngành)
          data/ml/salary_model_report.json (chỉ số đánh giá + so sánh baseline)

Chạy:  python -I ml/train_salary_model.py --parquet ../data.parquet
"""

import argparse
import json
import math
import os
import sys
import time
from collections import Counter

import numpy as np
import pandas as pd
import xgboost as xgb

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import features as F  # noqa: E402

if sys.platform.startswith("win"):
    sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "..", "data", "ml")
QUANTILES = {"p25": 0.25, "p50": 0.5, "p75": 0.75}
TEST_YEAR = 2026
CAL_YEAR = 2025
TARGET_COVERAGE = 0.5
N_TITLE_TOKENS = 300
N_INDUSTRY_SEGMENTS = 40
NUMERIC = ["exp_years", "edu_level", "pos_level", "year"]
FLAGS = list(F.REGIONS) + list(F.JOB_TYPES)


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def load(parquet_path):
    cols = ["job_title", "company_name", "salary", "location", "job_type", "job_industry",
            "experience_level", "education_level", "job_position", "year"]
    df = pd.read_parquet(parquet_path, columns=cols)
    n_raw = len(df)
    parsed = df["salary"].map(F.parse_salary_million)
    df = df[parsed.notna()].copy()
    parsed = parsed[parsed.notna()]
    df["sal_lo"] = [p[0] for p in parsed]
    df["sal_hi"] = [p[1] for p in parsed]
    df["sal_mid"] = (df["sal_lo"] + df["sal_hi"]) / 2
    n_parsed = len(df)
    df["title_norm"] = df["job_title"].map(F.norm_text)
    df = df.drop_duplicates(["title_norm", "company_name", "salary"]).reset_index(drop=True)
    log(f"rows raw={n_raw:,} salary_parsed={n_parsed:,} after_dedup={len(df):,}")
    return df, {"raw": n_raw, "salary_parsed": n_parsed, "deduplicated": len(df)}


def build_vocab(train_df):
    tok_df = Counter()
    for t in train_df["job_title"]:
        tok_df.update(F.title_tokens(t))
    title_vocab = [t for t, c in tok_df.most_common() if c >= 400][:N_TITLE_TOKENS]
    seg_df = Counter()
    for v in train_df["job_industry"]:
        seg_df.update(F.industry_segments(v))
    seg_df.pop("chua xac dinh", None)
    industry_vocab = [s for s, c in seg_df.most_common() if c >= 1500][:N_INDUSTRY_SEGMENTS]
    return title_vocab, industry_vocab


def build_matrix(df, feature_names, title_vocab, industry_vocab):
    idx = {f: i for i, f in enumerate(feature_names)}
    X = np.zeros((len(df), len(feature_names)), dtype=np.float32)
    title_set = set(title_vocab)
    seg_set = set(industry_vocab)
    for r, row in enumerate(df.itertuples(index=False)):
        for name, val in (("exp_years", F.parse_experience(row.experience_level)),
                          ("edu_level", F.parse_education(row.education_level)),
                          ("pos_level", F.parse_position(row.job_position)),
                          ("year", float(row.year))):
            X[r, idx[name]] = np.nan if val is None else val
        for k, v in F.region_flags(row.location).items():
            X[r, idx[k]] = v
        for k, v in F.job_type_flags(row.job_type).items():
            X[r, idx[k]] = v
        for s in F.industry_segments(row.job_industry) & seg_set:
            X[r, idx["ind:" + s]] = 1.0
        for t in F.title_tokens(row.job_title) & title_set:
            X[r, idx["t:" + t]] = 1.0
    return X


MAX_BIN = 128


def train_quantile(dtr, dva, alpha, feature_names):
    # Ràng buộc đơn điệu: với các yếu tố khác giữ nguyên, lương không giảm theo kinh nghiệm,
    # học vấn và cấp bậc. Tránh cây ngoại suy sai ở vùng thưa dữ liệu (> 8 năm kinh nghiệm).
    monotone = {"exp_years": 1, "edu_level": 1, "pos_level": 1}
    params = {
        "monotone_constraints": "(" + ",".join(str(monotone.get(f, 0)) for f in feature_names) + ")",
        "objective": "reg:quantileerror", "quantile_alpha": alpha, "max_bin": MAX_BIN,
        "tree_method": "hist", "max_depth": 7, "eta": 0.08,
        "min_child_weight": 20, "subsample": 0.8, "colsample_bytree": 0.8,
        "lambda": 1.0, "nthread": max(1, (os.cpu_count() or 4) - 2), "seed": 42,
    }
    booster = xgb.train(params, dtr, num_boost_round=1000, evals=[(dva, "val")],
                        early_stopping_rounds=30, verbose_eval=100)
    booster = booster[: booster.best_iteration + 1]
    return booster


# ---------------------------------------------------------------- export
def export_trees(booster, feature_names):
    fidx = {f: i for i, f in enumerate(feature_names)}
    trees = []
    for raw in booster.get_dump(dump_format="json"):
        root = json.loads(raw)
        nodes, order = {}, []

        def walk(n):
            nodes[n["nodeid"]] = n
            order.append(n["nodeid"])
            for c in n.get("children", []):
                walk(c)

        walk(root)
        pos = {nid: i for i, nid in enumerate(order)}
        f, t, y, no, m, v = [], [], [], [], [], []
        for nid in order:
            n = nodes[nid]
            if "leaf" in n:
                f.append(-1); t.append(0); y.append(-1); no.append(-1); m.append(-1)
                v.append(round(float(n["leaf"]), 7))
            else:
                f.append(fidx[n["split"]]); t.append(float(n["split_condition"]))
                y.append(pos[n["yes"]]); no.append(pos[n["no"]]); m.append(pos[n["missing"]])
                v.append(0)
        trees.append({"f": f, "t": t, "y": y, "n": no, "m": m, "v": v})
    return trees


def eval_trees(trees, x):
    """Bộ đánh giá giống hệt careerModelService.js (dùng để kiểm parity)."""
    total = 0.0
    for tr in trees:
        i = 0
        while tr["f"][i] != -1:
            val = x[tr["f"][i]]
            if val is None or (isinstance(val, float) and math.isnan(val)):
                i = tr["m"][i]
            else:
                i = tr["y"][i] if np.float32(val) < np.float32(tr["t"][i]) else tr["n"][i]
        total += tr["v"][i]
    return total


def metrics(y_true, y_pred, lo=None, hi=None):
    err = np.abs(y_pred - y_true)
    ape = err / y_true
    out = {
        "n": int(len(y_true)),
        "mae_million": round(float(err.mean()), 3),
        "median_ae_million": round(float(np.median(err)), 3),
        "mape_percent": round(float(ape.mean() * 100), 2),
        "within_20pct_percent": round(float((ape <= 0.20).mean() * 100), 2),
    }
    if lo is not None:
        out["p25_p75_coverage_percent"] = round(float(((y_true >= lo) & (y_true <= hi)).mean() * 100), 2)
        out["mean_interval_width_million"] = round(float((hi - lo).mean()), 3)
    return out


def market_trends(df, industry_vocab):
    years = sorted(y for y in df["year"].unique() if y < TEST_YEAR)
    totals = df[df["year"] < TEST_YEAR].groupby("year").size().to_dict()
    seg_rows = {s: [] for s in industry_vocab}
    for i, v in enumerate(df["job_industry"]):
        for s in F.industry_segments(v):
            if s in seg_rows:
                seg_rows[s].append(i)
    # Nguồn dữ liệu trộn nhiều trang tuyển dụng, nhãn ngành xuất hiện/biến mất theo năm
    # (vd "lao động phổ thông": 2 tin năm 2022 -> 12.158 tin năm 2025). Vì vậy chỉ tính xu hướng
    # giữa các năm có đủ mẫu, giới hạn biên độ và gắn cờ reliable.
    min_postings, cap, y_last = 500, 0.25, years[-1]
    out = {}
    for s, rows in seg_rows.items():
        sub = df.iloc[rows]
        per_year = {}
        for y in years:
            g = sub[sub["year"] == y]
            per_year[str(y)] = {
                "postings": int(len(g)),
                "share_percent": round(len(g) / totals[y] * 100, 3),
                "median_salary_million": round(float(g["sal_mid"].mean()), 2) if len(g) else None,
            }
        valid = [y for y in years if per_year[str(y)]["postings"] >= min_postings]
        y0 = valid[0] if valid else y_last
        span = y_last - y0
        p0, p1 = per_year[str(y0)], per_year[str(y_last)]
        ok = span >= 2 and p1["postings"] >= min_postings
        cagr = lambda a, b: max(-cap, min(cap, (b / a) ** (1 / span) - 1)) if ok and a and b else 0.0
        out[s] = {
            "years": per_year,
            "trend_window": [int(y0), int(y_last)],
            "reliable": bool(ok),
            "demand_momentum_cagr": round(cagr(p0["share_percent"], p1["share_percent"]), 4),
            "salary_cagr": round(cagr(p0["median_salary_million"], p1["median_salary_million"]), 4),
            "total_postings": int(len(sub)),
        }
    return {"period": [int(years[0]), int(y_last)], "industries": out,
            "method": f"CAGR giữa năm đầu có >= {min_postings} tin và {y_last}; cần >= 2 năm; giới hạn ±{int(cap * 100)}%/năm. "
                      "salary = trung bình điểm giữa khoảng lương."}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--parquet", default=os.path.join(HERE, "..", "..", "data.parquet"))
    ap.add_argument("--market-intel", default=os.path.join(HERE, "..", "data", "rag", "market_intelligence.json"))
    ap.add_argument("--trends-only", action="store_true", help="chỉ tính lại market_trends.json với vocab đã export")
    args = ap.parse_args()
    os.makedirs(OUT_DIR, exist_ok=True)

    df, counts = load(args.parquet)
    if args.trends_only:
        with open(os.path.join(OUT_DIR, "salary_model.json"), encoding="utf-8") as f:
            industry_vocab = json.load(f)["vocab"]["industry_segments"]
        with open(os.path.join(OUT_DIR, "market_trends.json"), "w", encoding="utf-8") as f:
            json.dump(market_trends(df, industry_vocab), f, ensure_ascii=False, indent=1)
        log("market_trends.json recomputed")
        return
    train_mask = (df["year"] < TEST_YEAR).values
    title_vocab, industry_vocab = build_vocab(df[train_mask])
    feature_names = NUMERIC + FLAGS + ["ind:" + s for s in industry_vocab] + ["t:" + t for t in title_vocab]
    log(f"features={len(feature_names)} (title tokens={len(title_vocab)}, industry segments={len(industry_vocab)})")

    X = build_matrix(df, feature_names, title_vocab, industry_vocab)
    y = np.log(df["sal_mid"].values.astype(np.float64))
    log(f"matrix built {X.shape} ~{X.nbytes / 1e6:.0f} MB")

    # Chia theo thời gian: dữ liệu năm gần nhất trước tập test (2025) được chia 50% huấn luyện,
    # 25% dừng sớm (val), 25% hiệu chỉnh conformal (cal). Tập test 2026 không bị đụng tới.
    rng = np.random.default_rng(42)
    years = df["year"].values
    te_idx = np.where(~train_mask)[0]
    recent = np.where(years == CAL_YEAR)[0]
    rng.shuffle(recent)
    q1, q2 = len(recent) // 4, len(recent) // 2
    va_idx, cal_idx = recent[:q1], recent[q1:q2]
    fit_idx = np.concatenate([np.where(train_mask & (years != CAL_YEAR))[0], recent[q2:]])

    dtr = xgb.QuantileDMatrix(X[fit_idx], label=y[fit_idx], feature_names=feature_names, max_bin=MAX_BIN)
    dva = xgb.QuantileDMatrix(X[va_idx], label=y[va_idx], feature_names=feature_names, max_bin=MAX_BIN, ref=dtr)
    boosters = {}
    for name, alpha in QUANTILES.items():
        log(f"training {name} (alpha={alpha}) on {len(fit_idx):,} rows")
        boosters[name] = train_quantile(dtr, dva, alpha, feature_names)
    del dtr, dva

    # ---------------- evaluation on 2026 holdout
    dte = xgb.DMatrix(X[te_idx], feature_names=feature_names)
    # Conformalized Quantile Regression (Romano et al., NeurIPS 2019), phiên bản "dự báo trước 1 năm":
    # model dùng thật dự báo năm SAU dữ liệu huấn luyện, nên độ lệch phải đo ở cùng điều kiện đó.
    # Huấn luyện model thăm dò P25/P75 trên các năm < CAL_YEAR, chấm trên tập cal của CAL_YEAR:
    # E_i = max(q25 - y, y - q75) (log); nới khoảng thêm c = phân vị ceil((n+1)·a)/n của E.
    probe_idx = np.where(train_mask & (years < CAL_YEAR))[0]
    dprobe = xgb.QuantileDMatrix(X[probe_idx], label=y[probe_idx], feature_names=feature_names, max_bin=MAX_BIN)
    dcal = xgb.DMatrix(X[cal_idx], feature_names=feature_names)
    y_cal = y[cal_idx]
    probe = {}
    for name, alpha in (("p25", 0.25), ("p75", 0.75)):
        log(f"training drift probe {name} on {len(probe_idx):,} rows (< {CAL_YEAR})")
        params = {"objective": "reg:quantileerror", "quantile_alpha": alpha, "max_bin": MAX_BIN, "tree_method": "hist",
                  "max_depth": 7, "eta": 0.1, "min_child_weight": 20, "subsample": 0.8, "colsample_bytree": 0.8,
                  "monotone_constraints": "(" + ",".join(str({"exp_years": 1, "edu_level": 1, "pos_level": 1}.get(f, 0)) for f in feature_names) + ")",
                  "nthread": max(1, (os.cpu_count() or 4) - 2), "seed": 42}
        probe[name] = xgb.train(params, dprobe, num_boost_round=400)
    del dprobe
    in_period = np.maximum(boosters["p25"].predict(dcal) - y_cal, y_cal - boosters["p75"].predict(dcal))
    scores = np.maximum(probe["p25"].predict(dcal) - y_cal, y_cal - probe["p75"].predict(dcal))
    n_cal = len(scores)
    level = min(1.0, np.ceil((n_cal + 1) * TARGET_COVERAGE) / n_cal)
    cqr_offset = max(0.0, float(np.quantile(scores, level)))
    in_period_offset = float(np.quantile(in_period, level))
    log(f"CQR offset year-ahead = {cqr_offset:.4f} (in-period would be {in_period_offset:.4f}) on {n_cal:,} rows")

    m_te = {k: b.predict(dte) for k, b in boosters.items()}
    raw25, raw50, raw75 = np.sort(np.vstack([m_te["p25"], m_te["p50"], m_te["p75"]]), axis=0)
    p50 = np.exp(raw50)
    p25_raw, p75_raw = np.exp(raw25), np.exp(raw75)
    p25, p75 = np.exp(raw25 - cqr_offset), np.exp(raw75 + cqr_offset)
    y_te = df["sal_mid"].values[te_idx]

    tr_df = df[train_mask]
    global_median = float(tr_df["sal_mid"].median())
    ind_median = tr_df.groupby("job_industry")["sal_mid"].median().to_dict()
    te_ind = df["job_industry"].values[te_idx]
    with open(args.market_intel, encoding="utf-8") as f:
        mi = json.load(f)
    mi_lookup = {k: v["salary_vnd_million"]["avg_median"] for k, v in mi.items()}
    base_current = np.array([mi_lookup.get(i, global_median) for i in te_ind])
    base_ind = np.array([ind_median.get(i, global_median) for i in te_ind])

    te_df = df.iloc[te_idx]
    exp = te_df["experience_level"].map(F.parse_experience).values
    edu = te_df["education_level"].map(F.parse_education).values
    fresher = np.array([(e is not None and e <= 1) and (d is not None and d >= 3) for e, d in zip(exp, edu)])

    report = {
        "model": "FT-Salary v2 (XGBoost quantile, log-salary, monotone constraints, CQR-calibrated)",
        "data": counts,
        "split": {"train_years": "2022-2024 + 50% of 2025", "test_year": TEST_YEAR,
                  "train_rows": int(len(fit_idx)), "val_rows": int(len(va_idx)), "calibration_rows": int(len(cal_idx)), "test_rows": int(len(te_idx))},
        "trees": {k: int(b.num_boosted_rounds()) for k, b in boosters.items()},
        "calibration": {
            "method": "Year-ahead Conformalized Quantile Regression (Romano et al. 2019): offset đo bằng model thăm dò huấn luyện trên các năm trước, chấm trên năm hiệu chỉnh",
            "calibration_year": CAL_YEAR,
            "calibration_rows": int(n_cal),
            "target_coverage_percent": TARGET_COVERAGE * 100,
            "interval_offset_log": round(cqr_offset, 5),
            "in_period_offset_log": round(in_period_offset, 5),
            "test_coverage_before_percent": metrics(y_te, p50, p25_raw, p75_raw)["p25_p75_coverage_percent"],
            "test_coverage_after_percent": metrics(y_te, p50, p25, p75)["p25_p75_coverage_percent"],
        },
        "test_all": {
            "ft_salary_p50": metrics(y_te, p50, p25, p75),
            "baseline_current_system_industry_median": metrics(y_te, base_current),
            "baseline_train_median_by_raw_industry": metrics(y_te, base_ind),
            "baseline_global_median": metrics(y_te, np.full_like(y_te, global_median)),
        },
        "test_fresher_graduates": {
            "ft_salary_p50": metrics(y_te[fresher], p50[fresher], p25[fresher], p75[fresher]),
            "baseline_current_system_industry_median": metrics(y_te[fresher], base_current[fresher]),
        },
    }
    mae_new = report["test_all"]["ft_salary_p50"]["mae_million"]
    mae_old = report["test_all"]["baseline_current_system_industry_median"]["mae_million"]
    report["mae_reduction_vs_current_percent"] = round((1 - mae_new / mae_old) * 100, 1)
    gain = boosters["p50"].get_score(importance_type="total_gain")
    total_gain = sum(gain.values()) or 1
    report["top_features_by_gain"] = [
        {"feature": k, "gain_share_percent": round(v / total_gain * 100, 2)}
        for k, v in sorted(gain.items(), key=lambda kv: -kv[1])[:20]
    ]
    log(json.dumps(report["test_all"], ensure_ascii=False, indent=1))

    # ---------------- export + parity
    export = {
        "version": "ft-salary-2",
        "trained_at": time.strftime("%Y-%m-%d"),
        "target": "log(monthly salary midpoint, million VND)",
        # careerModelService: p25 = exp(m25 - offset), p75 = exp(m75 + offset)
        "calibration": {"interval_offset_log": cqr_offset, "target_coverage": TARGET_COVERAGE},
        "feature_names": feature_names,
        "vocab": {"title_tokens": title_vocab, "industry_segments": industry_vocab},
        "quantiles": {},
    }
    sample = te_idx[:300]
    parity = {"rows": [], "expected": {}}
    for name, b in boosters.items():
        trees = export_trees(b, feature_names)
        margins = b.predict(xgb.DMatrix(X[sample], feature_names=feature_names), output_margin=True)
        sums = np.array([eval_trees(trees, [None if np.isnan(v) else float(v) for v in X[i]]) for i in sample])
        base = float(np.median(margins - sums))
        drift = float(np.abs(margins - sums - base).max())
        log(f"{name}: {len(trees)} trees, base_score={base:.6f}, parity max |diff|={drift:.2e}")
        if drift > 1e-3:
            raise SystemExit(f"Parity check failed for {name}: {drift}")
        export["quantiles"][name] = {"base_score": base, "trees": trees}
        parity["expected"][name] = [float(m) for m in margins[:50]]
    parity["rows"] = [[None if np.isnan(v) else float(v) for v in X[i]] for i in sample[:50]]
    parity["raw"] = df.iloc[sample[:50]][["job_title", "job_industry", "experience_level",
                                          "education_level", "job_position", "location",
                                          "job_type", "year"]].astype(str).to_dict("records")

    with open(os.path.join(OUT_DIR, "salary_model.json"), "w", encoding="utf-8") as f:
        json.dump(export, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(OUT_DIR, "salary_model_parity.json"), "w", encoding="utf-8") as f:
        json.dump(parity, f, ensure_ascii=False)
    report["market_trends_file"] = "market_trends.json"
    with open(os.path.join(OUT_DIR, "market_trends.json"), "w", encoding="utf-8") as f:
        json.dump(market_trends(df, industry_vocab), f, ensure_ascii=False, indent=1)
    with open(os.path.join(OUT_DIR, "salary_model_report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    log(f"exported to {os.path.abspath(OUT_DIR)}")


if __name__ == "__main__":
    main()
