"""
Kiểm chứng nhóm lương với dữ liệu tuyển dụng thật: trong mỗi nhóm ngành (job_industry), chức danh nào chiếm bao nhiêu %.
Dùng để quyết định mức khớp (`fit`) trong crosswalk.py và để người duyệt có bằng chứng.
    python -I data_pipeline/build_segment_evidence.py [--parquet D:/fpt/data.parquet]
Xuất: data/knowledge/segment_evidence.json
"""
import argparse, collections, json, os, re, sys, unicodedata
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.abspath(os.path.join(HERE, ".."))
if sys.platform.startswith("win"):
    sys.stdout.reconfigure(encoding="utf-8")


def nt(s):
    s = unicodedata.normalize("NFD", str(s).lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn").replace("đ", "d")
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


# nhóm lương -> {nhãn hiển thị: regex chức danh (không dấu)}
CHECKS = {
    "y te cham soc suc khoe": {"trình dược viên": "trinh duoc", "điều dưỡng": "dieu duong", "bác sĩ": "bac si", "nha khoa": "nha khoa", "xét nghiệm": "xet nghiem", "dược sĩ": "duoc si"},
    "duoc pham": {"trình dược viên": "trinh duoc", "OTC": "otc", "dược sĩ": "duoc si", "nhà thuốc": "nha thuoc"},
    "giao duc dao tao": {"giáo viên": "giao vien", "giảng viên": "giang vien", "tư vấn tuyển sinh": "tuyen sinh", "mầm non": "mam non", "trợ giảng": "tro giang"},
    "tai chinh dau tu chung khoan": {"kế toán": "ke toan", "tín dụng": "tin dung", "đầu tư": "dau tu", "chứng khoán": "chung khoan", "phân tích": "phan tich"},
    "ngan hang": {"thanh toán": "thanh toan", "tín dụng": "tin dung", "giao dịch viên": "giao dich vien", "tài chính": "tai chinh"},
    "luat phap ly tuan thu": {"pháp chế": "phap che", "pháp lý": "phap ly", "luật sư": "luat su", "tuân thủ": "tuan thu"},
    "kien truc thiet ke noi ngoai that": {"kiến trúc sư": "kien truc su", "nội thất": "noi that", "thiết kế": "thiet ke"},
    "xay dung": {"kỹ sư xây dựng": "ky su xay dung", "giám sát": "giam sat", "dự toán": "du toan", "an toàn": "an toan"},
    "dien dien tu dien lanh": {"kỹ sư điện": "ky su dien", "điện tử": "dien tu", "điện lạnh": "dien lanh", "bảo trì": "bao tri", "viễn thông": "vien thong"},
    "co khi o to tu dong hoa": {"cơ khí": "co khi", "ô tô": "o to", "tự động hóa": "tu dong hoa", "PLC": "plc", "cơ điện tử": "co dien tu", "chế tạo": "che tao"},
    "khach san nha hang du lich": {"bếp": "bep", "phục vụ": "phuc vu", "lễ tân": "le tan", "du lịch": "du lich", "điều hành tour": "dieu hanh tour", "hướng dẫn viên": "huong dan vien"},
    "bien phien dich": {"phiên dịch": "phien dich", "tiếng Trung": "tieng trung", "tiếng Anh": "tieng anh", "tiếng Nhật": "tieng nhat", "tiếng Hàn": "tieng han"},
    "khoa hoc ky thuat": {"kỹ sư": "ky su", "kỹ thuật viên": "ky thuat vien", "nghiên cứu": "nghien cuu", "phòng thí nghiệm": "phong thi nghiem", "môi trường": "moi truong", "sinh học": "sinh hoc"},
    "quan ly tieu chuan va chat luong": {"QC": "qc", "QA": "qa", "chất lượng": "chat luong", "môi trường": "moi truong", "an toàn": "an toan"},
    "cong nghe thuc pham dinh duong": {"thực phẩm": "thuc pham", "dinh dưỡng": "dinh duong", "QA": "qa", "R&D": "r d"},
    "it phan mem": {"lập trình": "lap trinh", "developer": "developer", "tester": "tester", "dữ liệu": "data", "AI": "ai"},
    "marketing": {"marketing": "marketing", "content": "content", "SEO": "seo", "truyền thông": "truyen thong", "PR": "pr"},
    "nhan su": {"nhân sự": "nhan su", "tuyển dụng": "tuyen dung", "hành chính": "hanh chinh"},
    "ke toan": {"kế toán": "ke toan", "tổng hợp": "tong hop", "nội bộ": "noi bo", "thuế": "thue"},
    "kiem toan": {"kế toán": "ke toan", "kiểm toán": "kiem toan"},
    "ban hang kinh doanh": {"kinh doanh": "kinh doanh", "bán hàng": "ban hang", "tư vấn": "tu van", "thị trường": "thi truong"},
    "thu mua kho van chuoi cung ung": {"xuất nhập khẩu": "xuat nhap khau", "kho": "kho", "thu mua": "thu mua", "logistics": "logistics"},
    "xuat nhap khau": {"xuất nhập khẩu": "xuat nhap khau", "chứng từ": "chung tu", "mua hàng": "mua hang"},
    "van tai lai xe giao nhan": {"lái xe": "lai xe", "tài xế": "tai xe", "giao hàng": "giao hang"},
    "bat dong san": {"kinh doanh": "kinh doanh", "bất động sản": "bat dong san", "tư vấn": "tu van"},
    "thiet ke sang tao nghe thuat": {"thiết kế": "thiet ke", "đồ họa": "do hoa", "graphic": "graphic", "video": "video"},
    "hanh chinh thu ky": {"hành chính": "hanh chinh", "nhân sự": "nhan su", "lễ tân": "le tan", "trợ lý": "tro ly"},
    "san xuat lap rap che bien": {"kỹ thuật": "ky thuat", "cơ khí": "co khi", "vận hành": "van hanh", "bảo trì": "bao tri"},
    "det may da giay thoi trang": {"thời trang": "thoi trang", "bán hàng": "ban hang", "thiết kế": "thiet ke", "đơn hàng": "don hang"},
    "quan ly du an": {"dự án": "du an", "giám sát": "giam sat", "giám đốc": "giam doc"},
}

ap = argparse.ArgumentParser()
ap.add_argument("--parquet", default=os.path.join(SERVER, "..", "data.parquet"))
args = ap.parse_args()

df = pd.read_parquet(args.parquet, columns=["job_title", "job_industry"])
df["ind"] = df["job_industry"].map(nt)
df["t"] = df["job_title"].map(nt)

out = {"source_postings": int(len(df)), "note": "Một tin có thể thuộc nhiều nhóm ngành; tỷ lệ = % tin của nhóm có chức danh chứa cụm từ.", "segments": {}}
for seg, checks in CHECKS.items():
    sub = df[df["ind"].str.contains(seg, regex=False)]
    shares = {lbl: round(float(sub["t"].str.contains(r"\b(?:" + pat + r")\b", regex=True).mean() * 100), 1) for lbl, pat in checks.items()}
    out["segments"][seg] = {"postings": int(len(sub)), "title_share_percent": shares}
with open(os.path.join(SERVER, "data", "knowledge", "segment_evidence.json"), "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
print(f"Đã ghi segment_evidence.json cho {len(out['segments'])} nhóm ngành từ {len(df)} tin")
