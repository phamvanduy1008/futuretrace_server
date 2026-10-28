"""
Xuất bảng duyệt chéo ngành -> nghề cho 2 thành viên (mở bằng Excel).
    python -I data_pipeline/export_crosswalk_review.py
Kết quả: D:/fpt/DOI_CHIEU_NGANH_NGHE.csv (UTF-8 có BOM). Mỗi dòng là một mã ngành xuất hiện trong dữ liệu điểm chuẩn,
sắp theo số chương trình giảm dần (duyệt từ trên xuống: 80% chương trình nằm ở ~120 dòng đầu).
"""
import csv, json, os, sys
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.abspath(os.path.join(HERE, ".."))
OUT = os.path.abspath(os.path.join(SERVER, "..", "DOI_CHIEU_NGANH_NGHE.csv"))

with open(os.path.join(SERVER, "data", "knowledge", "programs.json"), encoding="utf-8") as f:
    programs = json.load(f)

groups = defaultdict(list)
for p in programs:
    groups[p["major_code"] or "(nội bộ) " + p["major_name"].split("(")[0].strip()].append(p)

def _norm(x):
    import unicodedata, re
    x = unicodedata.normalize("NFD", str(x).lower().replace("đ", "d"))
    x = "".join(c for c in x if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]+", " ", x).strip()


EVID_PATH = os.path.join(SERVER, "data", "knowledge", "segment_evidence.json")
EVID = json.load(open(EVID_PATH, encoding="utf-8"))["segments"] if os.path.exists(EVID_PATH) else {}


def evidence(industry):
    if not industry:
        return ""
    seg = _norm(industry.split("/")[0])
    e = EVID.get(seg)
    if not e:
        return ""
    top = sorted(e["title_share_percent"].items(), key=lambda kv: -kv[1])[:4]
    return f"{e['postings']:,} tin; " + ", ".join(f"{k} {v}%" for k, v in top)


VERDICT = {
    "strong": "Giữ: chức danh của nhóm lương trùng với nghề của ngành học.",
    "approx": "Giữ ở mức GẦN ĐÚNG: cùng lĩnh vực nhưng nhóm tuyển dụng không trùng hoàn toàn với nghề; hệ thống đã gắn nhãn tham khảo.",
    "weak": "Chỉ THAM KHẢO: không có nhóm tuyển dụng tương ứng; lương của nhóm này không phản ánh nghề của ngành học.",
    "none": "KHÔNG lấy lương/ROI: không có thị trường tuyển dụng công khai (nhà nước, quân đội, công an, biểu diễn nghệ thuật).",
}

FIT_VI = {"strong": "khớp", "approx": "gần đúng", "weak": "yếu (chỉ tham khảo)", "none": "không có lương"}
rows = []
for code, ps in groups.items():
    names = Counter(p["major_name"] for p in ps)
    occ = Counter(json.dumps(p["occupation"], ensure_ascii=False, sort_keys=True) if p["occupation"] else "null" for p in ps).most_common(1)[0][0]
    occ = json.loads(occ) or {}
    rows.append({
        "Mã ngành": code,
        "Tên ngành (phổ biến nhất)": names.most_common(1)[0][0],
        "Số chương trình": len(ps),
        "Nhóm lương dùng": occ.get("industry") or "(không dùng lương)",
        "Chức danh": occ.get("role") or "",
        "Mức khớp": FIT_VI.get(occ.get("fit"), "chưa nối"),
        "Cách nối": {"major": "mã ngành", "field_group": "nhóm lĩnh vực", "name": "suy từ tên ngành"}.get(occ.get("match_level"), ""),
        "Bằng chứng từ 606.878 tin tuyển dụng": evidence(occ.get("industry")),
        "Kết luận rà soát chuyên gia (Claude, 2026-10-20)": VERDICT.get(occ.get("fit"), "Chưa nối"),
        "Kiến thức ngành": occ.get("domain") or "",
        "Người 1 xác nhận (đồng ý / sửa thành ...)": "",
        "Người 2 xác nhận (đồng ý / sửa thành ...)": "",
        "Ghi chú": "",
    })
rows.sort(key=lambda r: -r["Số chương trình"])
with open(OUT, "w", encoding="utf-8-sig", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
    w.writeheader()
    w.writerows(rows)
if sys.platform.startswith("win"):
    sys.stdout.reconfigure(encoding="utf-8")
print(f"Đã ghi {len(rows)} dòng -> {OUT}")
print("Phân bố mức khớp:", dict(Counter(r["Mức khớp"] for r in rows)))
