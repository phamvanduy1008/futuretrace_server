"""
Teacher open-weight cho dữ liệu huấn luyện v3 (viết theo phần + slot): Qwen3.5-35B-A3B (MoE, 3B tham số hoạt động,
giấy phép Apache 2.0 nên distill hợp lệ) bản FP8 qua vLLM trên Modal H100.

  modal deploy ml/serving/modal_teacher.py           # in ra URL ...--futuretrace-teacher-serve...modal.run
  # sinh dữ liệu (chỉ ghi đè biến môi trường cho lệnh này, không sửa .env production):
  TEACHER_ORDER=modal MODAL_LLM_URL=<URL> MODAL_LLM_MODEL=teacher MODAL_DISABLE_THINKING=1 MODAL_REPETITION_PENALTY=1.05 \
    LLM_TOTAL_TIMEOUT_MS=900000 node ml/finetune/build_sft_sections.js --n 50 --concurrency 8 --out data/sft_v3
  modal app stop futuretrace-teacher                  # xong thì dừng hẳn (GPU H100 ~$3,95/giờ)

Xác thực dùng chung secret "futuretrace-llm" (LLM_API_KEY) với model phục vụ.
"""

import os
import subprocess

import modal

TEACHER_MODEL = os.environ.get("TEACHER_MODEL", "Qwen/Qwen3.5-35B-A3B-FP8")
GPU = os.environ.get("TEACHER_GPU", "H100")   # FP8 chạy gốc trên Hopper; ~35GB trọng số, còn lại cho KV cache
VLLM_PORT = 8000

image = (
    # Bản CUDA "devel" có nvcc: vLLM/FlashInfer biên dịch JIT một số kernel lúc khởi động (image slim báo
    # "Could not find nvcc and default cuda_home='/usr/local/cuda' doesn't exist")
    modal.Image.from_registry("nvidia/cuda:12.9.1-devel-ubuntu22.04", add_python="3.12")
    .entrypoint([])
    .pip_install("vllm==0.31.0", "huggingface_hub[hf_transfer]")
    # Image không có nvcc: tắt DeepGEMM (cần biên dịch JIT, từng làm hỏng khởi động: "not home_path.empty()")
    .env({"HF_HUB_ENABLE_HF_TRANSFER": "1", "VLLM_USE_DEEP_GEMM": "0"})
)
hf_cache = modal.Volume.from_name("futuretrace-hf-cache", create_if_missing=True)
vllm_cache = modal.Volume.from_name("futuretrace-vllm-cache", create_if_missing=True)

app = modal.App("futuretrace-teacher")


@app.function(
    image=image,
    gpu=GPU,
    scaledown_window=5 * 60,
    timeout=24 * 60 * 60,
    volumes={"/root/.cache/huggingface": hf_cache, "/root/.cache/vllm": vllm_cache},
    secrets=[modal.Secret.from_name("futuretrace-llm")],
)
@modal.concurrent(max_inputs=64)
@modal.web_server(port=VLLM_PORT, startup_timeout=30 * 60)
def serve():
    cmd = [
        "vllm", "serve", TEACHER_MODEL,
        "--served-model-name", "teacher",
        "--host", "0.0.0.0",
        "--port", str(VLLM_PORT),
        "--api-key", os.environ["LLM_API_KEY"],
        "--max-model-len", "8192",            # prompt 1 phần (~3k token) + đầu ra (<=1,4k)
        "--gpu-memory-utilization", "0.92",
        "--enable-prefix-caching",            # 4 phần của cùng hồ sơ dùng chung phần đầu prompt
        "--gdn-prefill-backend", "triton",    # kernel lớp linear-attention của Qwen3.5: Triton, không cần biên dịch JIT bằng nvcc
        # vLLM >= 0.10 đổi "guided decoding" thành "structured outputs" (đã kiểm trên 0.31.0)
        "--structured-outputs-config", '{"backend": "xgrammar", "disable_any_whitespace": true}',
    ]
    subprocess.Popen(cmd)
