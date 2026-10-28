import pandas as pd
import requests

# 1. Điền đường link trang web chứa bảng điểm chuẩn bạn muốn cào
# Ví dụ URL ảo (bạn thay bằng link thật của trường trên VnExpress/Tuyensinh247)
url = 'https://diemthi.vnexpress.net/tra-cuu-dai-hoc/dai-hoc-bach-khoa-ha-noi-349' 

# Cần gắn Headers để trang web không tưởng mình là Bot spam
headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
}

print(f"Đang cào dữ liệu từ: {url}")
response = requests.get(url, headers=headers)

# 2. Phép thuật của Pandas: Tự động tìm tất cả các bảng (Table) trong mã HTML
try:
    tables = pd.read_html(response.text)
    
    # Thông thường bảng điểm chuẩn sẽ là bảng đầu tiên xuất hiện trên web (tables[0])
    df_diem_chuan = tables[0]
    
    # Xem trước 5 dòng đầu tiên
    print("Trích xuất thành công! Dữ liệu mẫu:")
    print(df_diem_chuan.head())
    
    # 3. Xuất thẳng ra file Excel
    ten_file_excel = 'diem_chuan_crawled.xlsx'
    df_diem_chuan.to_excel(ten_file_excel, index=False)
    print(f"\n Đã lưu toàn bộ dữ liệu vào file: {ten_file_excel}")

except ValueError:
    print("Không tìm thấy bảng dữ liệu nào trên trang web này. Có thể website dùng JavaScript để ẩn bảng.")
except Exception as e:
    print(f"Có lỗi xảy ra: {e}")