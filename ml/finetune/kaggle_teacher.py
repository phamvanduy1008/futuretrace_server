"""
Chạy trong 1 ô (cell) của Kaggle Notebook (Accelerator: GPU T4 x2, Internet: On) để dựng "teacher" open-weight
cho build_sft_dataset.js: Qwen2.5-14B-Instruct-AWQ qua vLLM (OpenAI-compatible) + đường hầm cloudflared miễn phí.

Sau khi chạy, ô này in ra:  MODAL_LLM_URL=https://xxxx.trycloudflare.com  và  MODAL_LLM_TOKEN=...
Dán 2 giá trị đó (cùng MODAL_LLM_MODEL=teacher) vào futuretrace_server/.env trên máy bạn, rồi chạy:
    TEACHER_ORDER=modal node ml/finetune/build_sft_dataset.js --n 3000 --concurrency 4 --fewshot 1 --out data/sft_t1
Phiên Kaggle giới hạn ~9–12 giờ; script tự tiếp tục từ chỗ dừng khi dựng lại teacher.
"""
import os, re, secrets, subprocess, sys, time, urllib.request

MODEL = os.environ.get("TEACHER_MODEL", "Qwen/Qwen2.5-14B-Instruct-AWQ")
TOKEN = secrets.token_urlsafe(24)

# Cài vLLM vào môi trường ẢO RIÊNG (Python 3.11 + torch đi kèm) để không đụng bộ thư viện sẵn có của Kaggle.
# Cài thẳng vào hệ thống từng gây lỗi torchaudio/CUDA không khớp và xung đột protobuf, numba.
VENV = "/tmp/vllm_env"
VPY = VENV + "/bin/python"
if not os.path.exists(VPY):
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "uv"], check=True)
    subprocess.run([sys.executable, "-m", "uv", "venv", VENV, "--python", "3.11"], check=True)
# 0.8.5 còn hỗ trợ GPU T4 (kiến trúc Turing) qua engine V0; các bản mới hơn bỏ Turing.
# transformers PHẢI ghim 4.51.3: bản mới (>=4.54) bỏ thuộc tính tokenizer mà vLLM 0.8.5 gọi
# (lỗi "Qwen2Tokenizer has no attribute all_special_tokens_extended"). setuptools: Triton cần, venv của uv không có sẵn.
# Luôn chạy (đã cài thì xong trong vài giây, chỉ hạ transformers xuống nếu đang ở bản mới).
subprocess.run([sys.executable, "-m", "uv", "pip", "install", "--python", VPY, "-q",
                "vllm==0.8.5.post1", "transformers==4.51.3", "setuptools", "wheel"], check=True)

if not os.path.exists("/tmp/cloudflared"):
    urllib.request.urlretrieve(
        "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64", "/tmp/cloudflared")
    os.chmod("/tmp/cloudflared", 0o755)

server = subprocess.Popen(
    [VPY, "-m", "vllm.entrypoints.openai.api_server",
     "--model", MODEL, "--served-model-name", "teacher",
     "--dtype", "half",                                       # T4 không có bf16; kiểu nén AWQ do vLLM tự nhận từ config model
     "--tensor-parallel-size", "2",
     "--max-model-len", "12288", "--gpu-memory-utilization", "0.90",
     "--enforce-eager",                                       # bỏ CUDA graph: chậm hơn chút nhưng tránh treo/hết bộ nhớ trên T4; có thể bỏ dòng này sau khi chạy ổn
     "--api-key", TOKEN, "--port", "8000"],
    stdout=open("/tmp/vllm.log", "w"), stderr=subprocess.STDOUT,
    # T4 x2 trên Kaggle không có NVLink/P2P: tắt P2P để NCCL không treo khi chia model sang 2 GPU
    env={**os.environ, "VLLM_USE_V1": "0", "VLLM_WORKER_MULTIPROC_METHOD": "spawn",
         "NCCL_P2P_DISABLE": "1", "NCCL_IB_DISABLE": "1"})

for _ in range(150):                                           # chờ tối đa ~25 phút tải model
    time.sleep(10)
    try:
        urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:8000/v1/models", headers={"Authorization": f"Bearer {TOKEN}"}), timeout=5)
        break
    except Exception:
        if server.poll() is not None:
            tail = open("/tmp/vllm.log").read().splitlines()
            errs = [l for l in tail if "Error" in l or "error" in l][-8:]
            print("\n".join(tail[-40:])); print("\n>>> DÒNG LỖI CHÍNH:\n" + "\n".join(errs))
            raise SystemExit("vLLM dừng sớm, xem log ở trên")
else:
    print(open("/tmp/vllm.log").read()[-3000:]); raise SystemExit("vLLM chưa sẵn sàng")

tunnel = subprocess.Popen(["/tmp/cloudflared", "tunnel", "--url", "http://127.0.0.1:8000", "--no-autoupdate"],
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
url = None
for line in tunnel.stdout:
    m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
    if m:
        url = m.group(0); break

print("\n==== DÁN VÀO .env CỦA futuretrace_server ====")
print(f"MODAL_LLM_URL={url}")
print(f"MODAL_LLM_TOKEN={TOKEN}")
print("MODAL_LLM_MODEL=teacher")
print("TEACHER_ORDER=modal\n(giữ ô này chạy; dừng notebook = dừng teacher)")
server.wait()
