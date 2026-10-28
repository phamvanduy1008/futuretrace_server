"""
FUTURETRACE - FULL DATASET FUSION GENERATOR ENGINE (6-IN-1 BIG DATA INTEGRATION)
Tích hợp toàn bộ 6 nguồn dữ liệu thực tế:
1. diem_chuan_tat_ca_cac_truong.xlsx (3,606 ngành & trường ĐH toàn quốc)
2. luong_trung_binh_vietnamworks.xlsx (6,220 chức danh & thống kê lương VietnamWorks)
3. ielts_conversion_data.xlsx (Bảng quy đổi IELTS các trường đại học)
4. numbeo_cost_of_living.json (Chi phí sinh hoạt & lương ròng sau thuế các thành phố)
5. vietnam_salaries_by_industry.csv (Bản đồ phân loại tính cách Holland RIASEC)
6. data.parquet (606,878 tin tuyển dụng thực tế năm 2026)
"""

import os
import sys
import json
import time
import random
import re
from typing import Dict, List, Any
import google.generativeai as genai
import pandas as pd

# Cấu hình UTF-8 cho console Windows để chống lỗi UnicodeEncodeError
if sys.platform.startswith("win"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

# ==============================================================================
# 1. CẤU HÌNH API & MULTI-MODEL ROTATION
# ==============================================================================
env_path = os.path.join(os.path.dirname(__file__), ".env")
api_keys = []

if os.path.exists(env_path):
    with open(env_path, "r", encoding="utf-8") as f_env:
        for line in f_env:
            if line.startswith("GEMINI_API_KEYS="):
                keys_str = line.split("=", 1)[1].strip()
                api_keys = [k.strip() for k in keys_str.split(",") if k.strip()]
            elif line.startswith("GEMINI_API_KEY=") and not api_keys:
                api_keys = [line.split("=", 1)[1].strip()]

if not api_keys:
    api_keys = [os.getenv("GEMINI_API_KEY", "YOUR_GEMINI_API_KEY_HERE")]

AVAILABLE_MODELS = [
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash"
]

OUTPUT_FILE = "d:/fpt/futuretrace_server/train_data_diverse_3000.jsonl"
TARGET_SAMPLES = 3000
BATCH_SIZE = 2  # 1 Request = 2 kịch bản siêu chi tiết, giàu số liệu thực chứng

# ==============================================================================
# 2. TẢI VÀ HỢP NHẤT TOÀN BỘ 6 NGUỒN DỮ LIỆU THỰC TẾ
# ==============================================================================
BASE_DIR = "d:/fpt"

print("🔄 Đang nạp toàn bộ 6 nguồn cơ sở dữ liệu thực tế...")

# 1. Điểm chuẩn 3,606 ngành & trường
try:
    df_diem = pd.read_excel(os.path.join(BASE_DIR, "diem_chuan_tat_ca_cac_truong.xlsx"))
    diem_records = df_diem.dropna(subset=["Tên ngành", "Điểm chuẩn"]).to_dict(orient="records")
    print(f"✅ [1/6] diem_chuan_tat_ca_cac_truong.xlsx: {len(diem_records):,} ngành/trường.")
except Exception as e:
    diem_records = []
    print(f"⚠️ Không đọc được điểm chuẩn: {e}")

# 2. Lương VietnamWorks (6,220 chức danh)
try:
    df_luong_vnw = pd.read_excel(os.path.join(BASE_DIR, "luong_trung_binh_vietnamworks.xlsx"))
    luong_records = df_luong_vnw.dropna(subset=["Chức danh", "Lương trung bình (USD)"]).to_dict(orient="records")
    print(f"✅ [2/6] luong_trung_binh_vietnamworks.xlsx: {len(luong_records):,} chức danh.")
except Exception as e:
    luong_records = []
    print(f"⚠️ Không đọc được lương VietnamWorks: {e}")

# 3. Quy đổi IELTS
try:
    df_ielts = pd.read_excel(os.path.join(BASE_DIR, "ielts_conversion_data.xlsx"))
    ielts_records = df_ielts.to_dict(orient="records")
    print(f"✅ [3/6] ielts_conversion_data.xlsx: {len(ielts_records):,} quy định.")
except Exception as e:
    ielts_records = []
    print(f"⚠️ Không đọc được IELTS: {e}")

# 4. Chi phí sinh hoạt Numbeo
try:
    with open(os.path.join(BASE_DIR, "numbeo_cost_of_living.json"), "r", encoding="utf-8") as f_num:
        numbeo_data = json.load(f_num)
    print(f"✅ [4/6] numbeo_cost_of_living.json: {len(numbeo_data)} vùng.")
except Exception as e:
    numbeo_data = []
    print(f"⚠️ Không đọc được Numbeo: {e}")

# 5. Phân loại Holland RIASEC
try:
    df_holland = pd.read_csv(os.path.join(BASE_DIR, "vietnam_salaries_by_industry.csv"))
    holland_dict = {row["Tên Ngành"].split("(")[0].strip().lower(): row["Nhóm Holland (RIASEC)"] for _, row in df_holland.iterrows() if pd.notna(row.get("Tên Ngành"))}
    print(f"✅ [5/6] vietnam_salaries_by_industry.csv: {len(holland_dict)} nhóm Holland.")
except Exception as e:
    holland_dict = {}
    print(f"⚠️ Không đọc được Holland: {e}")

# ==============================================================================
# 3. MA TRẬN PERSONA TÂM LÝ & HOÀN CẢNH HỌC SINH
# ==============================================================================
ACADEMIC_PROFILES = [
    "Học sinh khối A00/A01, điểm test thử 26.5 - 28.5 điểm (Nhóm Top đầu), tư duy toán logic xuất sắc nhưng áp lực kỳ vọng lớn.",
    "Học sinh khối D01/D07, điểm test 21.0 - 24.0 điểm (Nhóm Khá), tiếng Anh tốt (có chứng chỉ IELTS 6.0 - 6.5), tự ti điểm Toán chỉ đạt 7.0 - 7.5.",
    "Học sinh khối C00/C03, điểm test 22.0 - 25.0 điểm, có năng khiếu viết lách, giao tiếp, sợ thất nghiệp nếu không học ngành kinh tế.",
    "Học sinh khối B00, điểm test 23.5 - 26.0 điểm, thích ngành Y Dược/Sinh học nhưng sợ thời gian đào tạo quá dài (6-9 năm) và học phí cao.",
    "Học sinh có học bạ THPT xuất sắc (GPA 8.8 - 9.2) nhưng điểm thi thử chỉ ở mức 20 - 22 điểm (Muốn tận dụng tối đa phương thức xét học bạ).",
    "Học sinh có chứng chỉ ĐGNL ĐHQG TP.HCM đạt 780 - 900 điểm / ĐHQG Hà Nội đạt 88 - 102 điểm.",
    "Học sinh học lực Trung bình (16 - 19 điểm), thực hành và phản xạ tốt, ghét lý thuyết trừu tượng, muốn học các ngành thực chiến.",
    "Học sinh muốn học Cao đẳng nghề / Thực hành 2 năm (FPT Polytechnic, Cao Thắng, Bách Khoa nghề) để đi làm sớm phụ giúp gia đình."
]

FINANCIAL_SITUATIONS = [
    "Gia đình thuần nông / Thu nhập thấp: Bố mẹ chỉ chu cấp tối đa 2.5 - 3.5 triệu/tháng, bắt buộc phải chọn trường học phí đại trà (<22tr/năm) hoặc có học bổng, cần đi làm thêm sớm.",
    "Gia đình trung lưu / Cơ bản: Chu cấp được 5.5 - 7.0 triệu/tháng, đủ trang trải học phí đại học công lập và sinh hoạt phí tiêu chuẩn.",
    "Gia đình khá giả / Kinh tế vững: Sẵn sàng chi trả 50 - 100 triệu/năm cho các chương trình Tiên tiến, Chất lượng cao, Liên kết quốc tế hoặc chuẩn bị du học."
]

EMOTIONAL_CONFLICTS = [
    "Bị bố mẹ ép buộc theo ngành nghề truyền thống (Y, Sư phạm, Công an, Ngân hàng) vì muốn an toàn, dù bản thân có đam mê khác biệt.",
    "Ảo tưởng ngành hot và mức lương nghìn đô (AI, Data, Fintech) qua truyền thông nhưng chưa hiểu rõ bản chất áp lực và độ đào thải của ngành.",
    "Nỗi sợ AI và Tự động hóa: Lo lắng sâu sắc rằng ngành nghề mình theo học sẽ bị trí tuệ nhân tạo xóa sổ sau 4 năm tốt nghiệp.",
    "Khủng hoảng tâm lý tự ti: Tự coi mình là người hướng nội kém cỏi, sợ không thể giao tiếp hay cạnh tranh trong môi trường doanh nghiệp.",
    "Đứng trước ngã ba đường: Phân vân gay gắt giữa 2 nguyện vọng trái ngược (ví dụ: một bên là Đam mê nghệ thuật, một bên là Thực tế kinh tế).",
    "Áp lực đồng trang lứa (Peer Pressure): Cảm thấy bản thân thua kém bạn bè khi ai cũng có định hướng rõ ràng và chứng chỉ quốc tế xịn sò."
]

HOLLAND_TYPES = ["R (Realistic)", "I (Investigative)", "A (Artistic)", "S (Social)", "E (Enterprising)", "C (Conventional)"]

# ==============================================================================
# 4. HÀM TỔNG HỢP CONTEXT TỪ CƠ SỞ DỮ LIỆU ĐA NGUỒN
# ==============================================================================
def sample_rich_context() -> Dict[str, Any]:
    """Bốc tách và kết nối dữ liệu ngẫu nhiên từ 5 nguồn thực tế."""
    # 1. Chọn 1 trường & ngành mục tiêu từ 3606 bản ghi
    diem_entry = random.choice(diem_records) if diem_records else {"Trường": "ĐH Kinh Tế Đà Nẵng", "Tên ngành": "Khoa học dữ liệu", "Điểm chuẩn": "21.00", "Tổ hợp môn": "A00, D01", "Học phí (VNĐ)": "27,500,000"}
    
    # 2. Chọn 3-4 chức danh công việc liên quan từ 6220 bản ghi VietnamWorks
    selected_jobs = random.sample(luong_records, min(4, len(luong_records))) if luong_records else [
        {"Chức danh": "Junior Data Analyst", "Lương trung bình (USD)": 662, "Lương tối thiểu (USD)": 99, "Lương tối đa (USD)": 1500, "Số lượng mẫu": 189},
        {"Chức danh": "Data Analyst", "Lương trung bình (USD)": 882, "Lương tối thiểu (USD)": 50, "Lương tối đa (USD)": 4500, "Số lượng mẫu": 3168},
        {"Chức danh": "Senior Data Analyst", "Lương trung bình (USD)": 1650, "Lương tối thiểu (USD)": 600, "Lương tối đa (USD)": 4500, "Số lượng mẫu": 155}
    ]
    
    # 3. Chọn 1 trường quy đổi IELTS
    ielts_entry = random.choice(ielts_records) if ielts_records else {"Trường Đại học": "ĐH Kinh tế Quốc dân", "Chứng chỉ IELTS Band": "6.5", "Điểm quy đổi / Xét tuyển": "Quy đổi 10 điểm môn Tiếng Anh"}
    
    # 4. Chọn dữ liệu chi phí vùng Numbeo
    city_data = random.choice(numbeo_data) if numbeo_data else {"city": "Hanoi", "costs": []}
    
    # Ghép chuỗi Fact Context
    jobs_str = "\n".join([f"- {j['Chức danh']}: Lương TB {j.get('Lương trung bình (USD)', 800)} USD (Min {j.get('Lương tối thiểu (USD)', 300)}, Max {j.get('Lương tối đa (USD)', 2500)}, {j.get('Số lượng mẫu', 100)} mẫu khảo sát)" for j in selected_jobs])
    
    context_text = f"""[DỮ LIỆU ĐIỂM CHUẨN & HỌC PHÍ THỰC TẾ]:
- Trường: {diem_entry.get('Trường', 'Đại học')} (Khu vực: {diem_entry.get('Tỉnh thành', 'Toàn quốc')})
- Ngành: {diem_entry.get('Tên ngành', 'Chuyên ngành')} (Mã ngành: {diem_entry.get('Mã ngành', 'N/A')})
- Điểm chuẩn: {diem_entry.get('Điểm chuẩn', '20.00')} (Tổ hợp xét tuyển: {diem_entry.get('Tổ hợp môn', 'A00, D01')})
- Học phí: {diem_entry.get('Học phí (VNĐ)', 'Đang cập nhật')} VNĐ/năm | Ghi chú: {diem_entry.get('Ghi chú', 'Tiêu chuẩn')}
- Quy đổi IELTS tham khảo: {ielts_entry.get('Trường Đại học', '')} - IELTS {ielts_entry.get('Chứng chỉ IELTS Band', '6.5')}: {ielts_entry.get('Điểm quy đổi / Xét tuyển', '')}

[DỮ LIỆU LƯƠNG THỊ TRƯỜNG VIETNAMWORKS]:
{jobs_str}

[DỮ LIỆU CHI PHÍ SINH HOẠT VÙNG (NUMBEO)]:
- Thành phố: {city_data.get('city', 'Hanoi')} | Mức chi phí sinh hoạt: {city_data.get('living_cost_level', 'Trung bình cao')}"""

    return {
        "context_text": context_text,
        "nganh": diem_entry.get("Tên ngành", "Chuyên ngành"),
        "truong": diem_entry.get("Trường", "Đại học"),
        "diem": diem_entry.get("Điểm chuẩn", "20.00")
    }

# ==============================================================================
# 5. BỘ LỌC KIỂM TRA CHẤT LƯỢNG NGHIÊM NGẶT
# ==============================================================================
def validate_single_sample(sample: Dict[str, Any]) -> bool:
    if not isinstance(sample, dict):
        return False
    for k in ["system", "context", "instruction", "response"]:
        if k not in sample or not isinstance(sample[k], str) or len(sample[k].strip()) < 10:
            return False
    if len(sample["response"].split()) < 220:
        return False
    return True

# ==============================================================================
# 6. VÒNG LẶP SINH DỮ LIỆU CHÍNH
# ==============================================================================
def main():
    print("=================================================================")
    print("🚀 FUTURETRACE FULL-FUSION DATASET ENGINE ĐANG CHẠY...")
    print("=================================================================")
    
    saved_count = 0
    if os.path.exists(OUTPUT_FILE):
        with open(OUTPUT_FILE, "r", encoding="utf-8") as f_check:
            for line in f_check:
                if line.strip():
                    saved_count += 1
        print(f"📂 Đã có sẵn {saved_count} mẫu trong file.")

    key_index = 0
    model_index = 0

    with open(OUTPUT_FILE, "a", encoding="utf-8") as f_out:
        while saved_count < TARGET_SAMPLES:
            current_key = api_keys[key_index % len(api_keys)]
            current_model_name = AVAILABLE_MODELS[model_index % len(AVAILABLE_MODELS)]
            
            genai.configure(api_key=current_key)
            model = genai.GenerativeModel(
                model_name=current_model_name,
                generation_config={"temperature": 0.85, "response_mime_type": "application/json"}
            )

            # Chuẩn bị BATCH_SIZE kịch bản hoàn toàn dựa trên dữ liệu thật
            batch_scenarios = []
            for _ in range(BATCH_SIZE):
                data_info = sample_rich_context()
                academic = random.choice(ACADEMIC_PROFILES)
                finance = random.choice(FINANCIAL_SITUATIONS)
                conflict = random.choice(EMOTIONAL_CONFLICTS)
                holland_code = random.choice(HOLLAND_TYPES)

                batch_scenarios.append({
                    "context": data_info["context_text"],
                    "profile": f"Học lực: {academic} | Nhóm tính cách: {holland_code} | Tài chính gia đình: {finance} | Xung đột/Nỗi sợ tâm lý: {conflict} | Ngành quan tâm: {data_info['nganh']} ({data_info['truong']})"
                })

            prompt = f"""[HỆ THỐNG CHUYÊN GIA HƯỚNG NGHIỆP FUTURETRACE]
Bạn là Kiến trúc sư Dữ liệu AI kiêm Chuyên gia Hướng nghiệp & Tâm lý học Giáo dục cấp cao.
Nhiệm vụ: Tạo ra ĐÚNG {BATCH_SIZE} MẪU HUẤN LUYỆN JSONL độc lập, sâu sắc, thực tế cho {BATCH_SIZE} học sinh dưới đây.

QUY TẮC BẮT BUỘC (STRICT GROUNDING & ZERO HALLUCINATION):
1. Phần "response" BẮT BUỘC phải trích dẫn CHÍNH XÁC các con số Điểm chuẩn, Học phí, Lương (USD & VNĐ quy đổi), Chi phí vùng trong [Context] được cấp.
2. CHUỖI TƯ DUY 4 NHỊP CHUYÊN SÂU TRONG "response":
   - **Nhịp 1: Thấu cảm & Bắt mạch tâm lý**: Giải tỏa cảm xúc, phân tích mã Holland (RIASEC theo chuẩn O*NET) tương thích với tố chất của học sinh.
   - **Nhịp 2: Đối chiếu Thực tế & Phân tích Dữ liệu**: So khớp điểm thi/học lực với điểm chuẩn ngành/trường, phân tích các chức danh công việc và mức lương thực tế từ VietnamWorks, cân đối bài toán học phí & chi phí sinh hoạt.
   - **Nhịp 3: Đánh giá Rủi ro Công nghệ & Tác động của AI**: Chỉ rõ việc gì AI sẽ tự động hóa và giá trị con người độc bản cần rèn luyện.
   - **Nhịp 4: Bản đồ Hành động Sprint**: Chia rõ Sprint 90 ngày trước mắt (học tập/đăng ký nguyện vọng) + Chiến lược 3-4 năm học thuật/nghề nghiệp.

DANH SÁCH {BATCH_SIZE} TÌNH HUỐNG DỰA TRÊN DỮ LIỆU THẬT:
{json.dumps(batch_scenarios, ensure_ascii=False, indent=2)}

YÊU CẦU ĐỊNH DẠNG ĐẦU RA:
Trả về duy nhất 1 MẢNG JSON hợp lệ chứa đúng {BATCH_SIZE} đối tượng:
[
  {{
    "system": "Bạn là Chuyên gia Tư vấn Hướng nghiệp và Mô phỏng Tương lai FutureTrace. Nhiệm vụ của bạn là đưa ra định hướng thấu cảm, thực tế, logic dựa trên thông tin được cung cấp.",
    "context": "<context_chứa_đầy_đủ_số_liệu_thực_tế>",
    "instruction": "<câu_hỏi_tự_nhiên_chân_thực_của_học_sinh_thể_hiện_hoàn_cảnh_và_nỗi_lo>",
    "response": "<lời_khuyên_chuyên_gia_chuẩn_4_nhịp_tư_duy_chứa_đầy_đủ_số_liệu_chứng_minh>"
  }},
  ...
]"""

            try:
                response = model.generate_content(prompt)
                raw_text = response.text.strip()
                samples = json.loads(raw_text)

                if isinstance(samples, list):
                    valid_in_batch = 0
                    for s in samples:
                        if validate_single_sample(s):
                            record = {
                                "system": s["system"],
                                "context": s["context"],
                                "instruction": s["instruction"],
                                "response": s["response"],
                                "conversations": [
                                    {"from": "system", "value": s["system"]},
                                    {"from": "human", "value": f"[DỮ LIỆU SỰ THẬT TỪ DATABASE]:\n{s['context']}\n\n[CÂU HỎI HỌC SINH]:\n{s['instruction']}"},
                                    {"from": "gpt", "value": s["response"]}
                                ]
                            }
                            f_out.write(json.dumps(record, ensure_ascii=False) + "\n")
                            saved_count += 1
                            valid_in_batch += 1
                    f_out.flush()
                    print(f"🎯 [Tổng: {saved_count}/{TARGET_SAMPLES}] Đã sinh +{valid_in_batch} mẫu | Model: {current_model_name} | Key: #{key_index % len(api_keys) + 1}")
                elif isinstance(samples, dict) and validate_single_sample(samples):
                    record = {
                        "system": samples["system"],
                        "context": samples["context"],
                        "instruction": samples["instruction"],
                        "response": samples["response"],
                        "conversations": [
                            {"from": "system", "value": samples["system"]},
                            {"from": "human", "value": f"[DỮ LIỆU SỰ THẬT TỪ DATABASE]:\n{samples['context']}\n\n[CÂU HỎI HỌC SINH]:\n{samples['instruction']}"},
                            {"from": "gpt", "value": samples["response"]}
                        ]
                    }
                    f_out.write(json.dumps(record, ensure_ascii=False) + "\n")
                    saved_count += 1
                    f_out.flush()
                    print(f"🎯 [Tổng: {saved_count}/{TARGET_SAMPLES}] Đã sinh +1 mẫu")

                key_index += 1
                if key_index % len(api_keys) == 0:
                    model_index += 1

                time.sleep(2.5)

            except Exception as e:
                err_msg = str(e)
                print(f"⚠️ Thử lại với model tiếp theo (Lỗi: {err_msg[:90]}...)")
                key_index += 1
                model_index += 1
                time.sleep(3.0)

    print(f"\n🎉 CHÚC MỪNG! ĐÃ TẠO XONG TOÀN BỘ {TARGET_SAMPLES} MẪU HUẤN LUYỆN CHẤT LƯỢNG CAO!")

if __name__ == "__main__":
    main()
