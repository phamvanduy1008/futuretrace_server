"""
D3: xuất mẫu khoảng 10% chương trình để nhóm đối chiếu điểm chuẩn với thông báo CHÍNH THỨC của trường (tier A),
và nhập ngược kết quả.

  python -I data_pipeline/export_verification_sample.py              -> D:\\fpt\\DOI_CHIEU_DIEM_CHUAN.csv
  python -I data_pipeline/export_verification_sample.py --import     -> data_sources/cutoffs/verified_tier_a.csv

Chọn mẫu phân tầng (seed cố định): toàn bộ chương trình miền Trung đang demo + trường lớn + chương trình biến động
bất thường giữa 2 năm (> 3 điểm) + ngẫu nhiên phần còn lại cho đủ khoảng 10%.
Nhóm điền 3 cột: diem_chinh_thuc, url_chinh_thuc, ghi_chu. Khi import: khớp (lệch <= 0,05) thì ghi dòng tier A
verified=true; lệch thì dòng tier A ghi đè (build_knowledge ưu tiên nguồn verified).
"""

import argparse
import csv
import json
import os
import random
import sys

if sys.platform.startswith("win"):
    sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.abspath(os.path.join(HERE, ".."))
ROOT = os.path.abspath(os.path.join(SERVER, ".."))
OUT = os.path.join(ROOT, "DOI_CHIEU_DIEM_CHUAN.csv")
VERIFIED = os.path.join(ROOT, "data_sources", "cutoffs", "verified_tier_a.csv")
CENTRAL = {"Đà Nẵng", "Huế", "Thừa Thiên Huế", "Quảng Nam", "Quảng Ngãi"}
BIG = ("bach-khoa-ha-noi", "kinh-te-quoc-dan", "ngoai-thuong", "kinh-te-tp", "bach-khoa-dai-hoc-quoc-gia",
       "khoa-hoc-tu-nhien", "y-ha-noi", "y-duoc-tp", "can-tho", "ton-duc-thang", "su-pham-ha-noi")
COLS = ["program_id", "truong", "tinh", "ma", "nganh", "nam", "phuong_thuc", "to_hop", "diem_trong_he_thong",
        "ly_do_chon", "diem_chinh_thuc", "url_chinh_thuc", "ghi_chu"]


def export(fraction):
    with open(os.path.join(SERVER, "data", "knowledge", "programs.json"), encoding="utf-8") as f:
        programs = json.load(f)
    with open(os.path.join(SERVER, "data", "knowledge", "schools.json"), encoding="utf-8") as f:
        schools = {s["id"]: s for s in json.load(f)}
    rnd = random.Random(20261022)
    picked = {}

    def pick(p, why):
        picked.setdefault(p["id"], (p, why))

    for p in programs:
        if p.get("is_floor_score"):
            continue
        prov = schools.get(p["school_id"], {}).get("province", "")
        hist = sorted(p.get("history") or [], key=lambda h: h["year"])
        if prov in CENTRAL:
            pick(p, "miền Trung (phạm vi demo)")
        elif any(b in p["school_id"] for b in BIG):
            pick(p, "trường lớn")
        elif len(hist) >= 2 and abs(hist[-1]["cutoff"] - hist[-2]["cutoff"]) > 3:
            pick(p, f"biến động {hist[-2]['cutoff']} -> {hist[-1]['cutoff']}")
    # Trường lớn: lấy mẫu 120 chương trình (đối chiếu theo trang của trường nên mỗi trường làm một lần)
    big = [k for k, (_, why) in picked.items() if why == "trường lớn"]
    rnd.shuffle(big)
    for k in big[120:]:
        picked.pop(k)
    target = min(int(len(programs) * fraction), len(picked))
    rest = [p for p in programs if p["id"] not in picked and not p.get("is_floor_score")]
    rnd.shuffle(rest)
    for p in rest[: max(0, target - len(picked))]:
        pick(p, "ngẫu nhiên")

    with open(OUT, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLS)
        w.writeheader()
        for p, why in sorted(picked.values(), key=lambda x: (x[0]["school_id"], x[0]["major_name"])):
            s = schools.get(p["school_id"], {})
            w.writerow({
                "program_id": p["id"], "truong": s.get("name", p["school_id"]), "tinh": s.get("province", ""),
                "ma": p.get("program_code") or p.get("major_code"), "nganh": p["major_name"], "nam": p["year"],
                "phuong_thuc": p["method"], "to_hop": ";".join(p.get("subject_groups") or []),
                "diem_trong_he_thong": p["cutoff"], "ly_do_chon": why,
                "diem_chinh_thuc": "", "url_chinh_thuc": "", "ghi_chu": "",
            })
    print(f"Đã xuất {len(picked)}/{len(programs)} chương trình -> {OUT}")


def do_import():
    with open(os.path.join(SERVER, "data", "knowledge", "schools.json"), encoding="utf-8") as f:
        schools = {s["name"]: s for s in json.load(f)}
    rows, same, diff = [], 0, 0
    with open(OUT, encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            v = (r.get("diem_chinh_thuc") or "").strip().replace(",", ".")
            url = (r.get("url_chinh_thuc") or "").strip()
            if not v or not url:
                continue
            official = float(v)
            if abs(official - float(r["diem_trong_he_thong"])) <= 0.05:
                same += 1
            else:
                diff += 1
            rows.append({
                "school_name": r["truong"], "province": r["tinh"], "program_code": r["ma"], "major_code": "",
                "major_name": r["nganh"], "year": r["nam"], "method": r["phuong_thuc"], "subject_groups": r["to_hop"],
                "cutoff": official, "scale": 30, "quota": "", "tuition_vnd": "", "tuition_unit": "", "source_url": url,
                "publisher": "Thông báo chính thức của trường", "tier": "A", "retrieved_at": "", "verified": "true",
            })
    cols = ["school_name", "province", "program_code", "major_code", "major_name", "year", "method", "subject_groups",
            "cutoff", "scale", "quota", "tuition_vnd", "tuition_unit", "source_url", "publisher", "tier", "retrieved_at", "verified"]
    with open(VERIFIED, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)
    print(f"Đã nhập {len(rows)} dòng đối chiếu: khớp {same}, lệch {diff} -> {VERIFIED}")
    print("Chạy lại: python -I data_pipeline/build_knowledge.py")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--import", dest="do_import", action="store_true")
    ap.add_argument("--fraction", type=float, default=0.10)
    a = ap.parse_args()
    do_import() if a.do_import else export(a.fraction)
