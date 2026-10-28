"""
FutureTrace ML - Feature engineering dùng chung cho huấn luyện.

QUAN TRỌNG: Mọi hàm ở đây phải được mirror 1-1 trong services/careerModelService.js
(normText, parseExperience, parseEducation, parsePosition, regionFlags, jobTypeFlags,
titleTokens). Script train_salary_model.py kiểm tra parity Python <-> JS sau khi export.
"""

import re
import unicodedata

NUM_RE = re.compile(r"\d+(?:[.,]\d+)*")


def norm_text(s):
    if s is None:
        return ""
    s = unicodedata.normalize("NFD", str(s).lower())
    s = "".join(c for c in s if not ("̀" <= c <= "ͯ"))
    s = s.replace("đ", "d")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return s.strip()


def _parse_number(tok):
    """'10.000.000' -> 10000000 ; '1,5' -> 1.5 ; '7.5' -> 7.5"""
    if re.fullmatch(r"\d{1,3}([.,]\d{3})+", tok):
        return float(re.sub(r"[.,]", "", tok))
    return float(tok.replace(",", "."))


def parse_salary_million(raw):
    """Trả về (low, high) triệu VND/tháng, hoặc None nếu không phải lương tháng hợp lệ."""
    if raw is None:
        return None
    s = str(raw).lower()
    if re.search(r"tuần|tuan|ngày|ngay|giờ|gio|nghìn|nghin|/h\b", s):
        return None
    if re.search(r"trên|tren|dưới|duoi|từ|tu |lên đến|len den|up to", s):
        return None
    nums = [_parse_number(t) for t in NUM_RE.findall(s)]
    if not nums or len(nums) > 2:
        return None
    is_usd = "usd" in s or "$" in s
    vals = []
    for v in nums:
        if is_usd:
            v = v * 25400 / 1e6
        elif v >= 100000:
            v = v / 1e6
        elif v >= 1000:
            return None  # mơ hồ (ví dụ "1500" không đơn vị)
        vals.append(v)
    lo, hi = min(vals), max(vals)
    if lo <= 0 or hi / lo > 5:
        return None
    mid = (lo + hi) / 2
    if not (2 <= mid <= 150):
        return None
    return lo, hi


def parse_experience(raw):
    n = norm_text(raw)
    if not n:
        return None
    if "duoi 1" in n:
        return 0.5
    nums = [float(x) for x in re.findall(r"\d+(?:\.\d+)?", n)]
    if nums:
        v = sum(nums[:2]) / len(nums[:2])
        return min(v, 20.0)
    if n.startswith("khong") or "chua co" in n:
        return 0.0
    return None


EDU_RULES = [
    (("dai hoc", "cu nhan", "ky su", "thac si"), 4.0),
    (("cao dang",), 3.0),
    (("trung cap",), 2.0),
    (("chung chi",), 1.5),
    (("trung hoc", "thpt"), 1.0),
    (("khong",), 0.0),
]


def parse_education(raw):
    n = norm_text(raw)
    for keys, val in EDU_RULES:
        if any(k in n for k in keys):
            return val
    return None


POSITION_RULES = [
    (("pho giam doc", "giam doc", "director"), 4.0),
    (("truong phong", "pho phong", "quan ly", "manager"), 3.0),
    (("truong nhom", "giam sat", "to truong", "leader", "truong ca"), 2.0),
    (("chuyen gia",), 2.5),
    (("chuyen vien",), 1.5),
    (("thuc tap",), 0.0),
    (("cong tac vien",), 0.5),
    (("nhan vien",), 1.0),
]


def parse_position(raw):
    n = norm_text(raw)
    for keys, val in POSITION_RULES:
        if any(k in n for k in keys):
            return val
    return None


REGIONS = {
    "reg_hcm": ("ho chi minh", "hcm", "sai gon", "thu duc"),
    "reg_hn": ("ha noi",),
    "reg_dn": ("da nang",),
    "reg_south_ind": ("binh duong", "dong nai", "long an", "ba ria", "vung tau"),
    "reg_north_ind": ("bac ninh", "hai phong", "hung yen", "hai duong", "vinh phuc", "bac giang", "quang ninh"),
}

JOB_TYPES = {
    "jt_fulltime": ("toan thoi gian",),
    "jt_parttime": ("ban thoi gian", "thoi vu", "theo ca"),
    "jt_intern": ("thuc tap",),
    "jt_remote": ("remote",),
}


def _flags(n, table):
    padded = f" {n} "
    return {k: 1.0 if any(f" {kw} " in padded for kw in kws) else 0.0 for k, kws in table.items()}


def region_flags(raw):
    return _flags(norm_text(raw), REGIONS)


def job_type_flags(raw):
    return _flags(norm_text(raw), JOB_TYPES)


def title_tokens(raw):
    """Unigram + bigram của tiêu đề đã chuẩn hóa (bỏ token thuần số)."""
    words = [w for w in norm_text(raw).split() if not w.isdigit()]
    toks = set(words)
    toks.update(f"{a} {b}" for a, b in zip(words, words[1:]))
    return toks


def industry_segments(raw):
    if raw is None:
        return set()
    return {norm_text(p) for p in str(raw).split("/") if norm_text(p)}
