"""
Crosswalk: mã ngành đào tạo (Bộ GD&ĐT, 7 chữ số) -> nhóm nghề trên thị trường tuyển dụng.

Cấu trúc (khớp theo tiền tố DÀI NHẤT: 7 chữ số -> 6 -> 5 -> 4 -> 3):
- `industry`: các đoạn ngành phân tách bằng " / ", đoạn ĐẦU TIÊN có dữ liệu thị trường sẽ được dùng để lấy lương.
  Mỗi đoạn phải thuộc đúng 37 nhóm ngành của dữ liệu tuyển dụng (kiểm bởi `validate()`).
- `role`: chức danh điển hình của người mới tốt nghiệp (token có trong vocab tiêu đề của FT-Salary).
- `riasec`: mã Holland điển hình (dùng cho "Độ phù hợp cá nhân").
- `fit`: mức khớp giữa ngành học và nhóm nghề dùng để lấy lương:
    strong  nhóm tuyển dụng tương ứng trực tiếp với nghề của ngành học
    approx  nhóm gần đúng (cùng lĩnh vực nhưng không phải đúng nghề, hoặc nghề chủ yếu ở khu vực khác)
    weak    không có nhóm tuyển dụng tương ứng; chỉ dùng nhóm gần nhất để tham khảo
    none    không có thị trường tuyển dụng công khai (quân đội, công an, biểu diễn nghệ thuật...): KHÔNG lấy lương
- `domain`: khóa kiến thức định tính (data/rag/domains_index.json), thay cho việc đoán theo từ khóa trong câu hỏi
  (tên trường chứa "Kinh tế" từng kéo nhầm ngành Marketing sang kiến thức tài chính).

TRẠNG THÁI: đã rà soát toàn bộ 354 mã ngành xuất hiện trong dữ liệu điểm chuẩn (bởi Claude, 2026-10-20),
CHƯA có người duyệt. Hai thành viên đọc chéo (xem mục 8 của HUONG_DAN_VAN_HANH.md) rồi đổi REVIEW_STATUS.
"""
import re
import unicodedata

REVIEW_STATUS = "reviewed_20261021_HoangLe_NguyenLe"

FITS = ("strong", "approx", "weak", "none")


def R(industry, role, riasec, fit, domain=None):
    return {"industry": industry, "role": role, "riasec": riasec, "fit": fit, "domain": domain}


# ----- nhóm nghề thường dùng -----
EDU = R("Giáo dục - Đào tạo", "Giáo viên", "SA", "approx", "su_pham_giao_duc")
IT = R("IT Phần mềm", "Kỹ sư phần mềm", "IR", "strong", "cntt")
IT_A = R("IT Phần mềm", "Kỹ sư phần mềm", "IR", "approx", "cntt")
MECH = R("Cơ khí - Ô tô - Tự động hóa", "Kỹ sư cơ khí", "RI", "strong", "ky_thuat_co_dien")
MECH_A = R("Cơ khí - Ô tô - Tự động hóa", "Kỹ sư kỹ thuật", "RI", "approx", "ky_thuat_co_dien")
ELEC = R("Điện - Điện tử - Điện lạnh", "Kỹ sư điện", "RI", "strong", "ky_thuat_co_dien")
ELEC_A = R("Điện - Điện tử - Điện lạnh", "Kỹ sư điện", "RI", "approx", "ky_thuat_co_dien")
MFG_A = R("Sản xuất - Lắp ráp - Chế biến", "Kỹ sư sản xuất", "RC", "approx", "ky_thuat_co_dien")
SCI_W = R("Khoa học - Kỹ thuật", "Chuyên viên nghiên cứu", "IR", "weak", None)
SCI_A = R("Khoa học - Kỹ thuật", "Kỹ thuật viên phòng thí nghiệm", "IR", "approx", None)
CONS = R("Xây dựng", "Kỹ sư xây dựng", "RI", "strong", "xay_dung_kien_truc")
ARCH = R("Kiến trúc - Thiết kế nội ngoại thất", "Kiến trúc sư", "AR", "strong", "xay_dung_kien_truc")
HEALTH = R("Y tế - Chăm sóc sức khỏe", "Nhân viên y tế", "IS", "strong", "y_duoc")
HEALTH_A = R("Y tế - Chăm sóc sức khỏe", "Nhân viên y tế", "IS", "approx", "y_duoc")
BIZ = R("Bán hàng - Kinh doanh", "Nhân viên kinh doanh", "EC", "strong", "kinh_te_tai_chinh")
BIZ_A = R("Bán hàng - Kinh doanh", "Nhân viên kinh doanh", "EC", "approx", "kinh_te_tai_chinh")
FIN_A = R("Tài chính - Đầu tư - Chứng Khoán", "Chuyên viên tài chính", "CE", "approx", "kinh_te_tai_chinh")
MKT = R("Marketing", "Nhân viên marketing", "EA", "strong", "marketing_truyen_thong")
MKT_A = R("Marketing", "Nhân viên content marketing", "AE", "approx", "marketing_truyen_thong")
LANG = R("Biên phiên dịch", "Nhân viên biên phiên dịch", "AS", "strong", "khoa_hoc_xa_hoi")
LANG_A = R("Biên phiên dịch", "Nhân viên biên phiên dịch", "AS", "approx", "khoa_hoc_xa_hoi")
ADMIN_W = R("Hành chính - Thư ký", "Nhân viên hành chính", "CE", "weak", "khoa_hoc_xa_hoi")
OTHER_W = R("Nghề nghiệp khác", "Chuyên viên nghiên cứu", "IS", "weak", "khoa_hoc_xa_hoi")
NONE_ = R(None, "Cán bộ", "RE", "none", None)
NONE_ARTS = R(None, "Nghệ sĩ / chuyên viên nghệ thuật", "AE", "none", None)  # biểu diễn nghệ thuật: không có thị trường tuyển dụng công khai
AGRI_W = R("Khoa học - Kỹ thuật", "Kỹ sư nông nghiệp", "RI", "weak", "nong_lam_ngu")
FOOD_A = R("Công nghệ thực phẩm - Dinh dưỡng / Thực phẩm - Đồ uống", "Kỹ sư công nghệ thực phẩm", "IR", "approx", "ky_thuat_co_dien")
TOUR = R("Khách sạn - Nhà hàng - Du lịch", "Nhân viên du lịch", "ES", "strong", "du_lich_khach_san")
TOUR_A = R("Khách sạn - Nhà hàng - Du lịch", "Nhân viên dịch vụ khách hàng", "ES", "approx", "du_lich_khach_san")
ENV_A = R("Quản lý tiêu chuẩn và chất lượng / Khoa học - Kỹ thuật", "Chuyên viên môi trường", "IR", "approx", "nong_lam_ngu")


def _merge(base, **kw):
    r = dict(base)
    r.update(kw)
    return r


# Khóa = tiền tố mã ngành (3-7 chữ số). Tiền tố dài hơn thắng.
RULES = {
    # ---- 714 Giáo dục - Đào tạo giáo viên: việc tuyển trên mạng chủ yếu là trung tâm/tư thục, không phải thang lương biên chế
    "714": EDU,
    # ---- 721 Nghệ thuật
    "721": R("Thiết kế - Sáng tạo nghệ thuật", "Nhân viên thiết kế", "AE", "weak", "thiet_ke_sang_tao"),
    "7210102": NONE_ARTS, "7210103": R("Thiết kế - Sáng tạo nghệ thuật", "Nhân viên thiết kế", "AE", "weak", "thiet_ke_sang_tao"),
    "7210104": R("Thiết kế - Sáng tạo nghệ thuật", "Nhân viên thiết kế", "AE", "weak", "thiet_ke_sang_tao"),
    "7210201": NONE_ARTS, "7210205": NONE_ARTS, "7210208": NONE_ARTS, "7210210": NONE_ARTS, "7210234": NONE_ARTS, "7210213": NONE_ARTS,
    "7210302": R("Thiết kế - Sáng tạo nghệ thuật", "Nhân viên dựng phim", "AE", "approx", "thiet_ke_sang_tao"),
    "7210402": R("Thiết kế - Sáng tạo nghệ thuật", "Nhân viên thiết kế", "AE", "strong", "thiet_ke_sang_tao"),
    "7210403": R("Thiết kế - Sáng tạo nghệ thuật", "Nhân viên thiết kế đồ họa", "AE", "strong", "thiet_ke_sang_tao"),
    "7210404": R("Dệt may - Da giày - Thời trang / Thiết kế - Sáng tạo nghệ thuật", "Nhân viên thiết kế thời trang", "AE", "approx", "thiet_ke_sang_tao"),
    "7210405": R("Kiến trúc - Thiết kế nội ngoại thất", "Nhân viên thiết kế nội thất", "AR", "strong", "thiet_ke_sang_tao"),
    "7210407": R("Thiết kế - Sáng tạo nghệ thuật", "Nhân viên thiết kế đồ họa", "AE", "approx", "thiet_ke_sang_tao"),
    "7210408": R("Thiết kế - Sáng tạo nghệ thuật", "Nhân viên thiết kế đồ họa", "AE", "strong", "thiet_ke_sang_tao"),
    "7210110": R("Thiết kế - Sáng tạo nghệ thuật", "Nhân viên thiết kế", "AE", "weak", "thiet_ke_sang_tao"),
    # ---- 722 Ngôn ngữ
    "722": LANG_A,
    "7220201": _merge(LANG, role="Nhân viên biên phiên dịch tiếng Anh", industry="Biên phiên dịch / Giáo dục - Đào tạo"),
    "7220202": LANG_A, "7220203": LANG, "7220204": _merge(LANG, role="Nhân viên biên phiên dịch tiếng Trung"),
    "7220205": LANG, "7220206": LANG_A, "7220208": LANG_A, "7220209": _merge(LANG, role="Nhân viên biên phiên dịch tiếng Nhật"),
    "7220210": _merge(LANG, role="Nhân viên biên phiên dịch tiếng Hàn"), "7220214": LANG_A, "7220220": _merge(LANG, role="Nhân viên biên phiên dịch tiếng Hàn"),
    "7220101": OTHER_W, "7220104": OTHER_W, "7220106": LANG_A, "7220110": R("Marketing", "Nhân viên content", "AE", "weak", "khoa_hoc_xa_hoi"),
    "7220112": OTHER_W, "7220301": OTHER_W,
    # ---- 7229 Nhân văn khác
    "7229": OTHER_W,
    "7229020": LANG_A,
    "7229030": R("Marketing", "Nhân viên content", "AE", "weak", "khoa_hoc_xa_hoi"),
    "7229040": ADMIN_W, "7229042": ADMIN_W, "7229047": OTHER_W,
    # ---- 731 Khoa học xã hội và hành vi
    "731": OTHER_W,
    "7310101": R("Tài chính - Đầu tư - Chứng Khoán / Bán hàng - Kinh doanh", "Chuyên viên phân tích kinh tế", "IC", "approx", "kinh_te_tai_chinh"),
    "7310102": FIN_A, "7310104": R("Tài chính - Đầu tư - Chứng Khoán", "Chuyên viên đầu tư", "CE", "approx", "kinh_te_tai_chinh"),
    "7310105": FIN_A, "7310109": R("Tài chính - Đầu tư - Chứng Khoán / IT Phần mềm", "Chuyên viên phân tích dữ liệu", "IC", "approx", "kinh_te_tai_chinh"),
    "7310110": R("Bán hàng - Kinh doanh / Hành chính - Thư ký", "Chuyên viên kinh tế", "EC", "approx", "kinh_te_tai_chinh"),
    "7310106": R("Xuất nhập khẩu / Tài chính - Đầu tư - Chứng Khoán", "Nhân viên xuất nhập khẩu", "EC", "approx", "logistics_xnk"),
    "7310107": R("Tài chính - Đầu tư - Chứng Khoán", "Chuyên viên phân tích số liệu", "IC", "approx", "kinh_te_tai_chinh"),
    "7310120": R("Xuất nhập khẩu / Thu mua - Kho Vận - Chuỗi cung ứng", "Nhân viên xuất nhập khẩu", "EC", "strong", "logistics_xnk"),
    "7310201": NONE_, "7310202": NONE_,
    "7310205": R("Hành chính - Thư ký", "Chuyên viên hành chính", "CE", "weak", "khoa_hoc_xa_hoi"),
    "7310206": R("Biên phiên dịch / Xuất nhập khẩu", "Chuyên viên đối ngoại", "EA", "weak", "khoa_hoc_xa_hoi"),
    "7310601": R("Biên phiên dịch / Xuất nhập khẩu", "Chuyên viên đối ngoại", "EA", "weak", "khoa_hoc_xa_hoi"),
    "7310608": LANG_A, "7310612": LANG_A, "7310613": LANG_A, "7310614": LANG_A, "7310640": LANG_A,
    "7310630": R("Khách sạn - Nhà hàng - Du lịch", "Nhân viên du lịch", "ES", "approx", "du_lich_khach_san"),
    "7310401": R("Nhân sự / Nghề nghiệp khác", "Chuyên viên tư vấn tâm lý", "SI", "approx", "khoa_hoc_xa_hoi"),
    "7310403": R("Giáo dục - Đào tạo", "Chuyên viên tâm lý học đường", "SI", "weak", "khoa_hoc_xa_hoi"),
    # ---- 732 Báo chí và thông tin
    "732": MKT_A,
    "7320104": _merge(MKT_A, role="Nhân viên truyền thông"),
    "7320108": R("Marketing", "Nhân viên quan hệ công chúng", "ES", "strong", "marketing_truyen_thong"),
    "7320201": ADMIN_W, "7320205": ADMIN_W, "7320303": ADMIN_W, "7320305": ADMIN_W,
    "7320402": R("Marketing", "Nhân viên biên tập", "AE", "weak", "marketing_truyen_thong"),
    "7329001": R("IT Phần mềm / Thiết kế - Sáng tạo nghệ thuật", "Lập trình viên game", "AI", "approx", "thiet_ke_sang_tao"),
    # ---- 734 Kinh doanh và quản lý
    "734": BIZ_A,
    "7340101": BIZ, "7340102": BIZ_A,
    "7340114": R("Marketing", "Nhân viên marketing số", "EA", "strong", "marketing_truyen_thong"),
    "7340115": MKT,
    "7340116": R("Bất động sản", "Nhân viên kinh doanh bất động sản", "EC", "strong", "xay_dung_kien_truc"),
    "7340120": R("Xuất nhập khẩu / Thu mua - Kho Vận - Chuỗi cung ứng", "Nhân viên xuất nhập khẩu", "EC", "strong", "logistics_xnk"),
    "7340121": BIZ,
    "7340122": R("Marketing / Bán hàng - Kinh doanh", "Nhân viên kinh doanh online", "EC", "strong", "marketing_truyen_thong"),
    "7340123": R("Dệt may - Da giày - Thời trang / Bán hàng - Kinh doanh", "Nhân viên kinh doanh thời trang", "EC", "approx", "kinh_te_tai_chinh"),
    "7340129": BIZ_A,
    "7340201": R("Ngân hàng / Tài chính - Đầu tư - Chứng Khoán", "Chuyên viên tài chính", "CE", "strong", "kinh_te_tai_chinh"),
    "7340202": R("Kế toán / Tài chính - Đầu tư - Chứng Khoán", "Nhân viên kế toán", "CI", "approx", "ke_toan_kiem_toan"),
    "7340204": R("Tài chính - Đầu tư - Chứng Khoán / Bán hàng - Kinh doanh", "Chuyên viên bảo hiểm", "EC", "approx", "kinh_te_tai_chinh"),
    "7340205": R("Tài chính - Đầu tư - Chứng Khoán / IT Phần mềm", "Chuyên viên công nghệ tài chính", "IC", "approx", "kinh_te_tai_chinh"),
    "7340206": R("Ngân hàng / Tài chính - Đầu tư - Chứng Khoán", "Chuyên viên tài chính", "CE", "approx", "kinh_te_tai_chinh"),
    "7340207": R("Tài chính - Đầu tư - Chứng Khoán / Bán hàng - Kinh doanh", "Chuyên viên bảo hiểm", "EC", "approx", "kinh_te_tai_chinh"),
    "7340301": R("Kế toán / Kiểm toán", "Nhân viên kế toán", "CI", "strong", "ke_toan_kiem_toan"),
    "7340302": R("Kiểm toán / Kế toán", "Nhân viên kiểm toán", "CI", "strong", "ke_toan_kiem_toan"),
    "7340401": ADMIN_W, "7340403": ADMIN_W,
    "7340404": R("Nhân sự / Hành chính - Thư ký", "Nhân viên nhân sự", "SE", "strong", "kinh_te_tai_chinh"),
    "7340405": R("IT Phần mềm", "Chuyên viên hệ thống thông tin", "IC", "approx", "cntt"),
    "7340406": R("Hành chính - Thư ký", "Nhân viên hành chính", "CE", "strong", "kinh_te_tai_chinh"),
    "7340409": R("Quản lý dự án", "Nhân viên quản lý dự án", "EC", "strong", "kinh_te_tai_chinh"),
    "7340412": R("Marketing", "Nhân viên tổ chức sự kiện", "EA", "approx", "marketing_truyen_thong"),
    "7349001": R("Ngân hàng / Tài chính - Đầu tư - Chứng Khoán", "Chuyên viên tài chính", "CE", "strong", "kinh_te_tai_chinh"),
    "7349002": BIZ,
    # ---- 738 Pháp luật
    "738": R("Luật - Pháp lý - Tuân thủ", "Chuyên viên pháp chế", "EI", "approx", "luat_phap_ly"),
    "7380107": R("Luật - Pháp lý - Tuân thủ", "Chuyên viên pháp chế doanh nghiệp", "EI", "strong", "luat_phap_ly"),
    "7380108": R("Luật - Pháp lý - Tuân thủ", "Chuyên viên pháp chế", "EI", "strong", "luat_phap_ly"),
    "7380109": R("Luật - Pháp lý - Tuân thủ", "Chuyên viên pháp chế", "EI", "strong", "luat_phap_ly"),
    # ---- 742 Khoa học sự sống
    "742": SCI_A,
    "7420204": R("Y tế - Chăm sóc sức khỏe", "Kỹ thuật viên phòng thí nghiệm", "IR", "approx", "y_duoc"),
    "7420207": R("Y tế - Chăm sóc sức khỏe", "Kỹ thuật viên thẩm mỹ", "ES", "weak", "y_duoc"),
    # ---- 744 Khoa học tự nhiên
    "744": SCI_W,
    "7440102": R("Điện - Điện tử - Điện lạnh", "Kỹ sư điện tử", "IR", "approx", "ky_thuat_co_dien"),
    "7440112": R("Sản xuất - Lắp ráp - Chế biến / Khoa học - Kỹ thuật", "Kỹ thuật viên hóa", "IR", "approx", "ky_thuat_co_dien"),
    "7440122": R("Sản xuất - Lắp ráp - Chế biến / Khoa học - Kỹ thuật", "Kỹ sư vật liệu", "IR", "approx", "ky_thuat_co_dien"),
    "7440229": R("IT Phần mềm", "Chuyên viên phân tích dữ liệu", "IC", "approx", "cntt"),
    "7440301": ENV_A, "7440298": ENV_A,
    # ---- 746 Toán và thống kê
    "746": R("IT Phần mềm / Tài chính - Đầu tư - Chứng Khoán", "Chuyên viên phân tích dữ liệu", "IC", "approx", "cntt"),
    "7460108": R("IT Phần mềm", "Chuyên viên khoa học dữ liệu", "IC", "strong", "cntt"),
    # ---- 748 Máy tính và CNTT
    "748": IT,
    "7480106": IT_A, "7480108": IT_A, "7480118": IT_A, "7480206": IT_A,
    "7480102": IT_A, "7489001": _merge(IT_A, role="Chuyên viên khoa học dữ liệu"), "7480203": _merge(IT_A, role="Kỹ sư dữ liệu"),
    "7480107": R("IT Phần mềm", "Kỹ sư trí tuệ nhân tạo", "IR", "strong", "cntt"),
    "7480202": R("IT Phần mềm", "Chuyên viên an toàn thông tin", "IR", "strong", "cntt"),
    "7480104": R("IT Phần mềm", "Chuyên viên hệ thống thông tin", "IC", "strong", "cntt"),
    # ---- 751 Công nghệ kỹ thuật
    "751": MECH_A,
    "7510101": R("Kiến trúc - Thiết kế nội ngoại thất / Xây dựng", "Kiến trúc sư", "AR", "approx", "xay_dung_kien_truc"),
    "7510102": CONS, "7510103": CONS, "7510104": CONS, "7510105": CONS, "7510106": CONS,
    "7510201": MECH, "7510202": MECH, "7510203": _merge(MECH, role="Kỹ sư cơ điện tử"),
    "7510205": _merge(MECH, role="Kỹ sư ô tô"),
    "7510206": R("Điện - Điện tử - Điện lạnh", "Kỹ sư nhiệt lạnh", "RI", "strong", "ky_thuat_co_dien"),
    "7510208": ELEC_A, "7510403": ELEC_A, "7510602": ELEC_A,
    "7510209": MECH_A, "7510210": R("Xây dựng", "Kỹ sư xây dựng", "RI", "approx", "xay_dung_kien_truc"),
    "7510301": ELEC, "7510302": _merge(ELEC, role="Kỹ sư điện tử viễn thông"),
    "7510303": _merge(MECH, role="Kỹ sư tự động hóa"),
    "7510401": MFG_A, "7510402": MFG_A, "7510801": MFG_A,
    "7510406": ENV_A, "7510407": SCI_W,
    "7510601": R("Sản xuất - Lắp ráp - Chế biến / Quản lý dự án", "Kỹ sư quản lý sản xuất", "EC", "approx", "ky_thuat_co_dien"),
    "7510605": R("Thu mua - Kho Vận - Chuỗi cung ứng / Xuất nhập khẩu", "Nhân viên logistics", "CE", "strong", "logistics_xnk"),
    "7510701": SCI_W,
    # ---- 752 Kỹ thuật
    "752": MECH_A,
    "7520103": MECH, "7520107": MECH_A, "7520114": _merge(MECH, role="Kỹ sư cơ điện tử"), "7520116": MECH,
    "7520117": MECH_A, "7520118": MECH_A, "7520120": MECH_A, "7520121": MECH_A, "7520122": MECH_A,
    "7520130": _merge(MECH, role="Kỹ sư ô tô"), "7520141": _merge(MECH, role="Kỹ sư ô tô"),
    "7520115": R("Điện - Điện tử - Điện lạnh", "Kỹ sư nhiệt lạnh", "RI", "approx", "ky_thuat_co_dien"),
    "7520201": ELEC, "7520207": _merge(ELEC, role="Kỹ sư điện tử viễn thông"),
    "7520208": R("IT Phần mềm / Điện - Điện tử - Điện lạnh", "Kỹ sư IoT", "IR", "approx", "cntt"),
    "7520212": R("Y tế - Chăm sóc sức khỏe", "Kỹ sư thiết bị y tế", "IR", "approx", "y_duoc"),
    "7520216": _merge(MECH, role="Kỹ sư tự động hóa"),
    "7520301": MFG_A, "7520309": MFG_A,
    "7520320": ENV_A,
    "7520503": R("Xây dựng", "Kỹ sư trắc địa", "RI", "approx", "xay_dung_kien_truc"),
    "7520206": SCI_W, "7520401": SCI_W, "7520402": SCI_W, "7520501": SCI_W, "7520502": SCI_W, "7520505": SCI_W,
    "7520601": SCI_W, "7520604": SCI_W, "7520605": SCI_W, "7520606": SCI_W, "7520607": SCI_W,
    # ---- 754 Sản xuất và chế biến
    "754": MFG_A,
    "7540101": R("Công nghệ thực phẩm - Dinh dưỡng / Thực phẩm - Đồ uống", "Kỹ sư công nghệ thực phẩm", "IR", "strong", "ky_thuat_co_dien"),
    "7540102": FOOD_A, "7540103": FOOD_A, "7540104": FOOD_A, "7540105": FOOD_A, "7540106": FOOD_A,
    "7540202": R("Dệt may - Da giày - Thời trang", "Kỹ sư dệt may", "RC", "strong", "ky_thuat_co_dien"),
    "7540203": R("Dệt may - Da giày - Thời trang", "Kỹ sư dệt may", "RC", "strong", "ky_thuat_co_dien"),
    "7540204": R("Dệt may - Da giày - Thời trang", "Kỹ sư dệt may", "RC", "strong", "ky_thuat_co_dien"),
    "7540209": R("Dệt may - Da giày - Thời trang", "Kỹ sư dệt may", "RC", "strong", "ky_thuat_co_dien"),
    "7549002": SCI_W,
    # ---- 758 Kiến trúc và xây dựng
    "758": CONS,
    "7580101": ARCH,
    "7580102": R("Kiến trúc - Thiết kế nội ngoại thất / Xây dựng", "Kiến trúc sư cảnh quan", "AR", "approx", "xay_dung_kien_truc"),
    "7580110": R("Kiến trúc - Thiết kế nội ngoại thất / Xây dựng", "Kiến trúc sư cảnh quan", "AR", "approx", "xay_dung_kien_truc"),
    "7580103": _merge(ARCH, role="Nhân viên thiết kế nội thất"),
    "7580108": _merge(ARCH, role="Nhân viên thiết kế nội thất"),
    "7580105": R("Xây dựng / Bất động sản", "Kỹ sư quy hoạch", "RI", "approx", "xay_dung_kien_truc"),
    "7580106": R("Xây dựng / Bất động sản", "Cán bộ quản lý đô thị", "CE", "approx", "xay_dung_kien_truc"),
    "7580109": R("Bất động sản / Xây dựng", "Chuyên viên bất động sản", "EC", "approx", "xay_dung_kien_truc"),
    "7580112": R("Xây dựng / Bất động sản", "Chuyên viên đô thị", "IC", "weak", "xay_dung_kien_truc"),
    "7580301": _merge(CONS, role="Kỹ sư dự toán"),
    "7580302": R("Xây dựng / Quản lý dự án", "Kỹ sư quản lý xây dựng", "RC", "strong", "xay_dung_kien_truc"),
    # ---- 762 Nông, lâm, thủy sản
    "762": AGRI_W,
    "7620115": R("Bán hàng - Kinh doanh", "Nhân viên kinh doanh nông sản", "EC", "weak", "nong_lam_ngu"),
    "7620119": R("Bán hàng - Kinh doanh", "Nhân viên kinh doanh nông sản", "EC", "weak", "nong_lam_ngu"),
    # ---- 764 Thú y
    "764": R("Y tế - Chăm sóc sức khỏe", "Bác sĩ thú y", "IR", "weak", "nong_lam_ngu"),
    # ---- 772 Sức khỏe
    "772": HEALTH,
    "7720101": R("Y tế - Chăm sóc sức khỏe", "Bác sĩ", "IS", "strong", "y_duoc"),
    "7720201": R("Dược phẩm / Y tế - Chăm sóc sức khỏe", "Dược sĩ", "IC", "strong", "y_duoc"),
    "7720203": R("Dược phẩm", "Nhân viên hóa dược", "IR", "approx", "y_duoc"),
    "7720301": R("Y tế - Chăm sóc sức khỏe", "Điều dưỡng", "SI", "strong", "y_duoc"),
    "7720501": R("Y tế - Chăm sóc sức khỏe", "Bác sĩ răng hàm mặt", "IR", "strong", "y_duoc"),
    "7720601": R("Y tế - Chăm sóc sức khỏe", "Kỹ thuật viên xét nghiệm", "IR", "strong", "y_duoc"),
    "7720401": R("Công nghệ thực phẩm - Dinh dưỡng / Y tế - Chăm sóc sức khỏe", "Chuyên viên dinh dưỡng", "IS", "approx", "y_duoc"),
    "7720497": R("Công nghệ thực phẩm - Dinh dưỡng / Y tế - Chăm sóc sức khỏe", "Chuyên viên dinh dưỡng", "IS", "approx", "y_duoc"),
    "7720701": HEALTH_A, "7720802": R("Y tế - Chăm sóc sức khỏe / Hành chính - Thư ký", "Cán bộ quản lý bệnh viện", "EC", "approx", "y_duoc"),
    "7729001": R("Y tế - Chăm sóc sức khỏe", "Nhân viên y tế", "IS", "weak", "y_duoc"),
    # ---- 776 Dịch vụ xã hội
    "776": R("Nghề nghiệp khác", "Nhân viên công tác xã hội", "SE", "weak", "khoa_hoc_xa_hoi"),
    # ---- 781 Du lịch, khách sạn, thể thao
    "781": TOUR_A,
    "7810101": TOUR, "7810103": _merge(TOUR, role="Nhân viên điều hành tour"),
    "7810201": _merge(TOUR, role="Nhân viên lễ tân khách sạn"), "7810202": _merge(TOUR, role="Quản lý nhà hàng"),
    "7810301": R("Khách sạn - Nhà hàng - Du lịch", "Nhân viên dịch vụ", "ES", "weak", "du_lich_khach_san"),
    "7810302": R("Khách sạn - Nhà hàng - Du lịch", "Nhân viên dịch vụ", "ES", "weak", "du_lich_khach_san"),
    "7810501": OTHER_W,
    "7819009": R("Thực phẩm - Đồ uống / Khách sạn - Nhà hàng - Du lịch", "Nhân viên bếp", "RE", "approx", "du_lich_khach_san"),
    "7819010": R("Thực phẩm - Đồ uống / Khách sạn - Nhà hàng - Du lịch", "Nhân viên bếp", "RE", "approx", "du_lich_khach_san"),
    # ---- 784 Dịch vụ vận tải
    "784": R("Vận Tải - Lái xe - Giao nhận / Thu mua - Kho Vận - Chuỗi cung ứng", "Nhân viên điều phối vận tải", "CE", "approx", "logistics_xnk"),
    "7840101": R("Vận Tải - Lái xe - Giao nhận / Thu mua - Kho Vận - Chuỗi cung ứng", "Nhân viên điều phối vận tải", "CE", "strong", "logistics_xnk"),
    "7840104": R("Vận Tải - Lái xe - Giao nhận / Thu mua - Kho Vận - Chuỗi cung ứng", "Nhân viên điều phối vận tải", "CE", "strong", "logistics_xnk"),
    # ---- 785 Môi trường
    "785": ENV_A,
    "7850103": R("Bất động sản / Khoa học - Kỹ thuật", "Cán bộ địa chính", "CI", "approx", "nong_lam_ngu"),
    "7850104": R("Khách sạn - Nhà hàng - Du lịch", "Nhân viên du lịch sinh thái", "ES", "approx", "du_lich_khach_san"),
    "7850105": R("Quản lý tiêu chuẩn và chất lượng", "Chuyên viên an toàn môi trường", "CI", "approx", "nong_lam_ngu"),
    "7850202": R("Quản lý tiêu chuẩn và chất lượng", "Chuyên viên an toàn lao động", "CI", "approx", "nong_lam_ngu"),
    # ---- 786 An ninh, quốc phòng (không có thị trường tuyển dụng công khai)
    "786": NONE_,
    # ---- 79 mã nội bộ của trường
    "7900204": ADMIN_W, "7900205": ADMIN_W,
    "7903124": R("Tài chính - Đầu tư - Chứng Khoán", "Chuyên viên tài chính", "CE", "approx", "kinh_te_tai_chinh"),
}

# ----- ĐIỀU CHỈNH `fit` DỰA TRÊN KIỂM CHỨNG VỚI 606.878 TIN TUYỂN DỤNG (data.parquet; chi tiết ở segment_evidence.json) -----
# Lý do mỗi nhóm điều chỉnh (tỷ lệ chức danh trong nhóm lương tương ứng):
#  - Y tế (16.014 tin): trình dược viên 20,5%, điều dưỡng 10,9%, bác sĩ 3,4%, xét nghiệm 0,7% -> lương của nhóm này
#    phản ánh nhân viên kinh doanh dược và điều dưỡng, KHÔNG phải bác sĩ/nha sĩ/kỹ thuật viên -> Y khoa, RHM, xét nghiệm: weak.
#  - Dược phẩm (15.283 tin): trình dược viên 21,1% so với dược sĩ 3,5% -> Dược học: approx.
#  - Tài chính-Đầu tư-Chứng khoán (21.535 tin): kế toán 31,2%, đầu tư 1,1%, chứng khoán 1,0% -> không phải đầu tư.
#  - Ngân hàng (10.668 tin): chủ yếu tín dụng tiêu dùng/hỗ trợ thanh toán (thanh toán 22,9%, tín dụng 11,8%, giao dịch viên 2,3%) -> approx.
#  - Luật (5.508 tin): pháp chế 12,2%, pháp lý 15,8%, luật sư 2,7% -> approx cho mọi ngành luật.
#  - Khách sạn-Nhà hàng-Du lịch (24.894 tin): bếp 6,9%, phục vụ 6,2%, lễ tân 3,9%, điều hành tour 0,8%, hướng dẫn viên 0,2% -> du lịch lữ hành: weak.
#  - Môi trường: 0,2% (QA/QC) và 1,6% (Khoa học-Kỹ thuật); Khoa học-Kỹ thuật chỉ 0,1-0,3% nghiên cứu/sinh học/phòng thí nghiệm -> weak.
#  - Cơ khí-Tự động hóa (25.741 tin): cơ khí 16,7%, ô tô 5,2%, tự động hóa 3,2%, PLC 0,2%, cơ điện tử 0,4% -> tự động hóa/cơ điện tử: approx.
#  - Điện-Điện tử (16.301 tin): kỹ sư điện 7,5%, bảo trì 12,0%, viễn thông 2,9% -> điện tử viễn thông: approx.
#  - IT Phần mềm (7.742 tin): lập trình 14,0%, developer 16,2%, data 4,2%, AI 3,4% -> AI/dữ liệu/an toàn thông tin: approx.
#  - Nông-lâm-thủy sản: hơn một nửa tin có chức danh nông nghiệp (kỹ sư nông nghiệp 454, thú y 287) không có nhãn ngành -> weak.
FIT_OVERRIDES = {
    "772": "weak", "7720101": "weak", "7720501": "weak", "7720601": "weak", "7720301": "approx", "7720201": "approx",
    "7720203": "weak", "7720401": "weak", "7720497": "weak", "7720701": "weak", "7720802": "weak", "7729001": "weak",
    "7380107": "approx", "7380108": "approx", "7380109": "approx",
    "7340201": "approx", "7340302": "approx", "7340301": "strong",
    "7310101": "weak", "7310102": "weak", "7310104": "weak", "7310105": "weak", "7310107": "weak", "7310109": "weak", "7310110": "weak",
    "781": "weak", "7810101": "weak", "7810103": "weak", "7810201": "approx", "7810202": "approx",
    "785": "weak", "7440301": "weak", "7440298": "weak", "7510406": "weak", "7520320": "weak",
    "7850103": "weak", "7850104": "weak", "7850105": "weak", "7850202": "weak",
    "742": "weak", "744": "weak",
    "7510203": "approx", "7520114": "approx", "7510303": "approx", "7520216": "approx", "7510209": "approx",
    "7510302": "approx", "7520207": "approx",
    "7480107": "approx", "7480202": "approx", "7460108": "approx",
    # Vòng rà soát 2 (2026-10-21): hạ mức khớp những ngành mà chức danh nhóm lương chỉ là một phần đầu ra
    "7340122": "approx", "7340120": "approx", "7480104": "approx", "7520212": "weak", "7340102": "weak", "7220209": "approx",
    "7580301": "approx", "7220201": "approx", "7220203": "approx", "7220205": "approx",
}
for _k, _fit in FIT_OVERRIDES.items():
    assert _k in RULES, f"FIT_OVERRIDES: không có quy tắc {_k}"
    RULES[_k] = dict(RULES[_k], fit=_fit)

# Mã nhập sai / mã liên kết trong dữ liệu nguồn -> mã chuẩn
CODE_FIXES = {
    "7334030": "7340301",   # Kế toán (hệ chất lượng cao): gõ nhầm 7334030
}

# ----- Suy mã ngành từ TÊN khi chương trình chỉ có mã nội bộ của trường -----
# (khớp theo tên chuẩn hóa; từ khóa dài/đặc thù đứng trước)
NAME_RULES = [
    # --- đặc thù trước, chung chung sau (khớp theo tên đã bỏ phần trong ngoặc, chuẩn hóa không dấu, nguyên từ)
    (r"kinh te xay dung", "7580301"), (r"quan ly xay dung|quan ly cong trinh", "7580302"),
    (r"luat kinh te|luat kinh doanh", "7380107"), (r"luat", "7380101"),
    (r"robot", "7510209"), (r"game|cong nghe da phuong tien", "7329001"),
    (r"ky thuat tau thuy|thiet ke tau|ngoai khoi", "7520122"),
    (r"kinh te van tai|van tai", "7840104"),
    (r"tau bien|tau thuy|hang hai|may tau|dieu khien tau", "7840106"),
    (r"duong sat|cao toc|cau duong|cong trinh giao thong", "7580205"),
    (r"bat dong san", "7340116"), (r"kinh doanh so", "7340122"), (r"kinh te so", "7310109"),
    (r"thuong mai dien tu|tmdt", "7340122"), (r"marketing", "7340115"),
    (r"quan tri kinh doanh|quan tri doanh nghiep|quan ly kinh doanh", "7340101"), (r"kinh doanh quoc te", "7340120"),
    (r"kinh doanh thuong mai", "7340121"),
    (r"cong nghe tai chinh|fintech", "7340205"), (r"tai chinh.*ngan hang|ngan hang", "7340201"),
    (r"kiem toan", "7340302"), (r"ke toan", "7340301"), (r"tai chinh", "7340201"),
    (r"quan tri nhan luc", "7340404"),
    (r"thuong mai quoc te|ngoai thuong|kinh te doi ngoai|kinh te quoc te", "7310106"),
    (r"logistics|logistic|chuoi cung ung|hai quan", "7510605"),
    (r"phan mem", "7480103"), (r"may tinh", "7480106"),
    (r"tri tue nhan tao", "7480107"), (r"an toan thong tin|an toan du lieu|an ninh mang", "7480202"),
    (r"khoa hoc du lieu|data science|ky thuat du lieu", "7460108"), (r"mang may tinh", "7480102"),
    (r"cong nghe thong tin|khoa hoc may tinh|he thong thong tin|iot|he thong nhung", "7480201"),
    (r"o to|oto|dong luc", "7510205"), (r"co dien tu", "7510203"), (r"che tao may", "7510202"),
    (r"nhiet lanh|ky thuat nhiet", "7510206"), (r"co khi", "7510201"),
    (r"kinh te cong nghiep|quan ly cong nghiep|quan ly ky thuat cong nghiep", "7510601"),
    (r"dieu khien|tu dong", "7510303"), (r"vien thong|ban dan|vi mach", "7510302"),
    (r"dien|nang luong", "7510301"),
    (r"cap thoat nuoc|co so ha tang|thuy van", "7580213"), (r"tai nguyen nuoc", "7850198"),
    (r"xay dung|cong trinh|giao thong|ha tang", "7580201"),
    (r"kien truc", "7580101"), (r"noi that", "7580108"), (r"quy hoach|do thi", "7580105"),
    (r"thuong mai quoc te", "7310106"),
    (r"hoa dau|hoa hoc|vat lieu", "7510402"),
    (r"y sinh", "7520212"),
    (r"thiet ke do hoa|do hoa|nghe thuat so|nghe thuat va thiet ke", "7210403"), (r"thoi trang", "7210404"),
    (r"dieu khac", "7210105"), (r"tao hinh|nhiep anh|hoi hoa", "7210103"),
    (r"bao chi|truyen thong", "7320104"), (r"quan he cong chung", "7320108"),
    (r"y khoa|y da khoa", "7720101"), (r"duoc hoc|duoc", "7720201"), (r"dieu duong", "7720301"),
    (r"rang.*ham.*mat", "7720501"), (r"xet nghiem", "7720601"), (r"hinh anh y hoc", "7720602"),
    (r"quan ly benh vien", "7720802"),
    (r"y hoc co truyen|y hoc du phong|y te cong cong|phuc hoi chuc nang|ho sinh", "7720115"),
    (r"giao duc mam non|mam non", "7140201"), (r"giao duc tieu hoc|tieu hoc", "7140202"), (r"su pham", "7140209"),
    (r"ngon ngu anh|tieng anh", "7220201"), (r"ngon ngu phap", "7220203"), (r"trung quoc", "7220204"),
    (r"ngon ngu nhat|nhat ban", "7220209"), (r"han quoc", "7220210"),
    (r"dong phuong hoc", "7310608"),
    (r"du lich|lu hanh", "7810103"), (r"khach san|nha hang", "7810201"),
    (r"cong nghe thuc pham|thuc pham", "7540101"), (r"moi truong|tai nguyen", "7850101"),
    (r"cong nghe sinh hoc|sinh hoc", "7420201"),
    (r"nong nghiep|lam nghiep|thuy san|chan nuoi|trong trot|thu y", "7620101"),
    (r"cong tac xa hoi", "7760101"), (r"tam ly", "7310401"),
    (r"quan ly nha nuoc|chinh tri|xay dung dang", "7310205"),
    (r"quan su|quan doi|chi huy|cong an|an ninh nhan dan|canh sat|phong chay", "7860201"),
    (r"kinh te", "7310101"),
]


def _norm(s):
    s = unicodedata.normalize("NFD", str(s or "").lower().replace("đ", "d"))
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def infer_code_from_name(name):
    n = _norm(re.sub(r"\(.*", "", str(name or "")))   # bỏ phần trong ngoặc (tăng cường tiếng Anh, liên kết...)
    for pat, code in NAME_RULES:
        if re.search(r"(?<![a-z0-9])(?:" + pat + r")(?![a-z0-9])", n):
            return code
    return None


def _match(code):
    code = CODE_FIXES.get(code, code)
    for n in range(len(code), 2, -1):
        rec = RULES.get(code[:n])
        if rec:
            return dict(rec), ("major" if n == 7 else "field_group")
    return None, None


# Kiến thức định tính (data/rag/domains_index.json) chỉ gắn khi nhóm lương trùng lĩnh vực của nó, tránh nhầm
# (vd. ngành Ngôn ngữ nhận chứng chỉ tâm lý, ngành Bán hàng nhận kỹ năng tài chính)
INDUSTRY_DOMAIN = {
    "Ngân hàng": "kinh_te_tai_chinh", "Tài chính - Đầu tư - Chứng Khoán": "kinh_te_tai_chinh",
    "Kế toán": "ke_toan_kiem_toan", "Kiểm toán": "ke_toan_kiem_toan", "IT Phần mềm": "cntt",
    "Y tế - Chăm sóc sức khỏe": "y_duoc", "Dược phẩm": "y_duoc", "Luật - Pháp lý - Tuân thủ": "luat_phap_ly",
    "Marketing": "marketing_truyen_thong", "Giáo dục - Đào tạo": "su_pham_giao_duc",
    "Thiết kế - Sáng tạo nghệ thuật": "thiet_ke_sang_tao", "Khách sạn - Nhà hàng - Du lịch": "du_lich_khach_san",
    "Xuất nhập khẩu": "logistics_xnk", "Thu mua - Kho Vận - Chuỗi cung ứng": "logistics_xnk",
    "Vận Tải - Lái xe - Giao nhận": "logistics_xnk", "Xây dựng": "xay_dung_kien_truc",
    "Kiến trúc - Thiết kế nội ngoại thất": "xay_dung_kien_truc", "Bất động sản": "xay_dung_kien_truc",
    "Cơ khí - Ô tô - Tự động hóa": "ky_thuat_co_dien", "Điện - Điện tử - Điện lạnh": "ky_thuat_co_dien",
}
EXPLICIT_DOMAIN = {  # tiền tố mã ngành -> domain chọn tay
    "7310401": "khoa_hoc_xa_hoi", "7310403": "khoa_hoc_xa_hoi", "776": "khoa_hoc_xa_hoi",
    "762": "nong_lam_ngu", "764": "nong_lam_ngu", "785": "nong_lam_ngu", "7440301": "nong_lam_ngu",
    "7440298": "nong_lam_ngu", "7510406": "nong_lam_ngu", "7520320": "nong_lam_ngu",
}


def _domain_for(code, rec):
    for n in range(len(code), 2, -1):
        if code[:n] in EXPLICIT_DOMAIN:
            return EXPLICIT_DOMAIN[code[:n]]
    if not rec.get("industry"):
        return None
    return INDUSTRY_DOMAIN.get(rec["industry"].split("/")[0].strip())


def lookup(major_code, major_name=None):
    """Bản ghi crosswalk cho mã ngành chuẩn 7 chữ số; nếu không có mã thì suy từ tên (match_level='name')."""
    code = str(major_code or "").strip()[:7]
    level_override = None
    if not code and major_name:
        code = infer_code_from_name(major_name) or ""
        level_override = "name"
    if not code:
        return None
    rec, level = _match(code)
    if rec is None:
        return None
    rec["match_level"] = level_override or level
    rec["domain"] = _domain_for(CODE_FIXES.get(code, code), rec)
    if rec["fit"] == "none":
        rec["industry"] = None
    return rec


def validate(market_industries):
    """Kiểm mọi đoạn `industry` trong RULES đều thuộc nhóm ngành có dữ liệu thị trường. Trả về danh sách lỗi."""
    errors = []
    known = set(market_industries)
    for key, rec in RULES.items():
        if rec["fit"] not in FITS:
            errors.append(f"{key}: fit không hợp lệ {rec['fit']}")
        if rec["industry"] is None:
            if rec["fit"] != "none":
                errors.append(f"{key}: industry rỗng nhưng fit={rec['fit']}")
            continue
        for seg in [s.strip() for s in rec["industry"].split("/")]:
            if _norm(seg) not in known:
                errors.append(f"{key}: đoạn ngành '{seg}' không có trong dữ liệu thị trường")
    return errors
