"""
Phục vụ model fine-tune FutureTrace (Qwen + LoRA đã merge) trên Modal serverless GPU bằng vLLM.

- API tương thích OpenAI: POST /v1/chat/completions (stream, response_format json_schema).
- Tự tắt sau SCALEDOWN_SECONDS không có request (không tốn tiền khi không ai dùng);
  backend gọi /health khi người dùng mở form để GPU khởi động trong lúc họ nhập liệu.
- Xác thực: Bearer token lấy từ Modal Secret "futuretrace-llm" (khóa LLM_API_KEY).

Triển khai (một lần):
  pip install modal && modal setup
  modal secret create futuretrace-llm LLM_API_KEY=<chuỗi ngẫu nhiên dài>
  modal volume create futuretrace-weights
  modal volume put futuretrace-weights ./futuretrace-qwen-merged /futuretrace-qwen    # thư mục model đã merge
  modal deploy ml/serving/modal_app.py
Sau đó đặt trong .env của backend:
  MODAL_LLM_URL=https://<workspace>--futuretrace-llm-serve.modal.run
  MODAL_LLM_TOKEN=<giống LLM_API_KEY>
  MODAL_LLM_MODEL=futuretrace-qwen
"""

import os
import subprocess

import modal

APP_NAME = "futuretrace-llm"
SERVED_MODEL_NAME = "futuretrace-qwen"
WEIGHTS_DIR = os.environ.get("FT_WEIGHTS_DIR", "/weights/futuretrace-qwen-v3")   # v3: student Qwen3-4B viết theo phần + slot (modal_train.py)
# Nhiều adapter trên cùng model gốc (1 GPU, 1 lần khởi động): mô phỏng giữ tên cũ "futuretrace-qwen" để backend không đổi
BASE_MODEL = "Qwen/Qwen3-4B-Instruct-2507"
LORA_ADAPTERS = {
    SERVED_MODEL_NAME: "/weights/futuretrace-qwen-v3/lora",     # mô phỏng 3 kịch bản (v3)
    "premium": "/weights/futuretrace-premium-v1/lora",           # lộ trình chuyên sâu (khởi đầu từ adapter mô phỏng)
}
GPU = os.environ.get("FT_GPU", "L4")              # L4 24GB: dư cho student 4B fp16
SCALEDOWN_SECONDS = 5 * 60                        # khớp MODAL_SCALEDOWN_MS ở backend
MAX_MODEL_LEN = 8192                              # v3: mỗi phần ~3k token prompt + <=1,4k đầu ra
VLLM_PORT = 8000

image = (
    # Cùng cấu hình đã chạy ổn cho teacher: CUDA devel (có nvcc cho kernel JIT), vLLM 0.31, tắt DeepGEMM
    modal.Image.from_registry("nvidia/cuda:12.9.1-devel-ubuntu22.04", add_python="3.12")
    .entrypoint([])
    .pip_install("vllm==0.31.0", "huggingface_hub[hf_transfer]")
    .env({
        "HF_HUB_ENABLE_HF_TRANSFER": "1", "VLLM_USE_DEEP_GEMM": "0",
        # Đệm biên dịch (Triton, torch.compile, FlashInfer) nằm trên volume: mỗi lần khởi động nguội là máy mới,
        # không có volume thì phải biên dịch lại từ đầu (đo 22/10: khởi tạo engine 158 s / tổng 248 s)
        "TRITON_CACHE_DIR": "/cache/triton",
        "TORCHINDUCTOR_CACHE_DIR": "/cache/inductor",
        "FLASHINFER_WORKSPACE_BASE": "/cache/flashinfer",
        "XDG_CACHE_HOME": "/cache/xdg",
    })
)

weights = modal.Volume.from_name("futuretrace-weights", create_if_missing=True)
vllm_cache = modal.Volume.from_name("futuretrace-vllm-cache", create_if_missing=True)
hf_cache = modal.Volume.from_name("futuretrace-hf-cache", create_if_missing=True)
compile_cache = modal.Volume.from_name("futuretrace-compile-cache", create_if_missing=True)

app = modal.App(APP_NAME)


@app.function(
    image=image,
    gpu=GPU,
    scaledown_window=SCALEDOWN_SECONDS,
    timeout=24 * 60 * 60,                # web_server: không để container bị thu hồi giữa lúc đang phục vụ (tự tắt khi rảnh vẫn theo scaledown_window)
    volumes={"/weights": weights, "/root/.cache/vllm": vllm_cache, "/cache": compile_cache, "/root/.cache/huggingface": hf_cache},
    secrets=[modal.Secret.from_name("futuretrace-llm")],
)
@modal.concurrent(max_inputs=16)
@modal.web_server(port=VLLM_PORT, startup_timeout=20 * 60)
def serve():
    adapters = {name: path for name, path in LORA_ADAPTERS.items() if os.path.exists(os.path.join(path, "adapter_config.json"))}
    if SERVED_MODEL_NAME in adapters:
        # Model gốc + adapter: mỗi request chọn adapter qua trường "model" (futuretrace-qwen | premium)
        model_args = [BASE_MODEL, "--served-model-name", "qwen3-4b-base", "--enable-lora", "--max-lora-rank", "16",
                      "--max-loras", str(len(adapters)),
                      "--lora-modules", *[f"{n}={p}" for n, p in adapters.items()]]
    else:
        model_args = [WEIGHTS_DIR, "--served-model-name", SERVED_MODEL_NAME]   # dự phòng: model đã gộp
    print("[serve] adapters:", adapters or "(không có, dùng model đã gộp)", flush=True)
    cmd = [
        "vllm", "serve", *model_args,
        "--host", "0.0.0.0",
        "--port", str(VLLM_PORT),
        "--api-key", os.environ["LLM_API_KEY"],
        "--max-model-len", str(MAX_MODEL_LEN),
        "--dtype", "auto",                   # v3 huấn luyện bf16 trên H100; L4 hỗ trợ bf16
        "--gpu-memory-utilization", "0.90",
        "--enable-prefix-caching",           # system prompt + hướng dẫn giống nhau giữa các request
        # Ràng buộc JSON Schema; cấm khoảng trắng tự do (model nhỏ dễ lặp xuống dòng/khoảng trắng tới hết max_tokens).
        # vLLM >= 0.10 đổi "guided decoding" thành "structured outputs" (đã kiểm trên 0.31.0)
        "--structured-outputs-config", '{"backend": "xgrammar", "disable_any_whitespace": true}',
        # Mỗi mô phỏng gửi 4 phần song song: chỉ chụp CUDA graph cho lô nhỏ thay vì hàng chục kích thước tới 512
        # (lô lớn hơn vẫn chạy đúng, chỉ không dùng graph). Rút ngắn khởi động, không đổi kết quả.
        "--max-num-seqs", "16",
        "--compilation-config", '{"cudagraph_capture_sizes": [1, 2, 4, 8, 16]}',
    ]
    for d in ("/cache/triton", "/cache/inductor", "/cache/flashinfer", "/cache/xdg"):
        os.makedirs(d, exist_ok=True)
    subprocess.Popen(cmd)

    # Server sẵn sàng thì ghi đệm biên dịch vào volume ngay (không đợi container tắt mới lưu)
    import threading
    import time
    import urllib.request

    def persist_cache():
        for _ in range(240):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{VLLM_PORT}/health", timeout=5)
                compile_cache.commit()
                vllm_cache.commit()
                hf_cache.commit()                # model gốc tải lần đầu được giữ cho lần khởi động sau
                print("[cache] đã lưu đệm biên dịch vào volume", flush=True)
                return
            except Exception:
                time.sleep(5)

    threading.Thread(target=persist_cache, daemon=True).start()
