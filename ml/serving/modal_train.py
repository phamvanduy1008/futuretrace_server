"""
Huấn luyện student v3 trên Modal H100 (LoRA bf16), dùng đúng ml/finetune/train_qlora_hf.py.
Kaggle T4 không kịp với ~10.000 mẫu theo phần (ước tính ~50 giờ/epoch); H100 khoảng 1-2 giờ.

  node ml/finetune/build_sft_sections.js --pack --out data/sft_v3          # ghi train.jsonl / val.jsonl
  modal run --detach ml/serving/modal_train.py --data data/sft_v3 --epochs 2
  # model đã gộp nằm ở volume futuretrace-weights:/futuretrace-qwen-v3 (modal_app.py đọc qua FT_WEIGHTS_DIR)
  # adapter premium khởi đầu từ adapter mô phỏng, chỉ lưu adapter:
  modal run --detach ml/serving/modal_train.py --data data/sft_premium --epochs 1 --out-name futuretrace-premium-v1       --init-adapter /weights/futuretrace-qwen-v3/lora --adapter-only

Không cần token Hugging Face: base Qwen/Qwen3-4B-Instruct-2507 là repo công khai.
"""

import os

import modal

HERE = os.path.dirname(os.path.abspath(__file__))
FINETUNE = os.path.abspath(os.path.join(HERE, "..", "finetune"))

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("torch==2.11.0", "transformers==5.16.1", "peft==0.21.2", "accelerate==1.15.0", "datasets", "hf_transfer")
    .env({"HF_HUB_ENABLE_HF_TRANSFER": "1", "TOKENIZERS_PARALLELISM": "false"})
    .add_local_file(os.path.join(FINETUNE, "train_qlora_hf.py"), "/app/train_qlora_hf.py")
)
weights = modal.Volume.from_name("futuretrace-weights", create_if_missing=True)
hf_cache = modal.Volume.from_name("futuretrace-hf-cache", create_if_missing=True)
app = modal.App("futuretrace-train")


# FT_TRAIN_TIMEOUT_H: giới hạn cứng thời gian GPU (chặn chi phí khi credit còn ít)
@app.function(image=image, gpu="H100", timeout=int(float(os.environ.get("FT_TRAIN_TIMEOUT_H", "6")) * 3600),
              volumes={"/weights": weights, "/root/.cache/huggingface": hf_cache})
def train(train_jsonl: bytes, val_jsonl: bytes, epochs: float, out_name: str, batch: int, grad_accum: int, lr: float,
          init_adapter: str = "", adapter_only: bool = False):
    import subprocess
    import shutil

    os.makedirs("/data", exist_ok=True)
    open("/data/train.jsonl", "wb").write(train_jsonl)
    open("/data/val.jsonl", "wb").write(val_jsonl)
    out = f"/tmp/{out_name}"
    cmd = ["python", "/app/train_qlora_hf.py", "--data", "/data", "--out", out, "--no-4bit",
           "--epochs", str(epochs), "--batch", str(batch), "--grad-accum", str(grad_accum), "--lr", str(lr),
           "--eval-steps", "100"]
    if init_adapter:
        cmd += ["--init-adapter", init_adapter]          # vd /weights/futuretrace-qwen-v3/lora (adapter mô phỏng)
    if adapter_only:
        cmd += ["--no-merge"]                           # phục vụ dạng nhiều adapter trên cùng model gốc
    print("RUN", " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True)
    # Lưu model đã gộp + adapter + số đo vào volume
    dest = f"/weights/{out_name}"
    if os.path.exists(dest):
        shutil.rmtree(dest)
    if adapter_only:
        os.makedirs(dest)
    else:
        shutil.copytree(f"{out}-merged", dest)
    shutil.copytree(os.path.join(out, "lora"), os.path.join(dest, "lora"))
    shutil.copy(os.path.join(out, "train_metrics.json"), os.path.join(dest, "train_metrics.json"))
    weights.commit()
    print("Đã lưu", dest, sorted(os.listdir(dest)), flush=True)
    return open(os.path.join(dest, "train_metrics.json")).read()


@app.local_entrypoint()
def main(data: str = "data/sft_v3", epochs: float = 2, out_name: str = "futuretrace-qwen-v3", batch: int = 4, grad_accum: int = 4, lr: float = 1e-4,
         init_adapter: str = "", adapter_only: bool = False):
    if "/weights/" in init_adapter:
        # Git Bash trên Windows tự đổi "/weights/..." thành "C:/Program Files/Git/weights/...": lấy lại đường dẫn trong volume
        init_adapter = init_adapter[init_adapter.index("/weights/"):]
    tr = open(os.path.join(data, "train.jsonl"), "rb").read()
    va = open(os.path.join(data, "val.jsonl"), "rb").read()
    metrics = train.remote(tr, va, epochs, out_name, batch, grad_accum, lr, init_adapter, adapter_only)
    open(os.path.join(data, "train_metrics.json"), "w", encoding="utf-8").write(metrics)
    print(metrics[:2000])
