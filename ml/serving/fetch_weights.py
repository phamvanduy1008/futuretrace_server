"""
Tải model đã merge từ Hugging Face (repo private) thẳng vào Modal Volume, khỏi tải về máy rồi upload lại.

  modal secret create huggingface-token HF_TOKEN=<token Read của Hugging Face>
  modal run ml/serving/fetch_weights.py --repo TÊN/futuretrace-qwen
  # đã tải rồi, chỉ cần sửa tokenizer cho vLLM:
  modal run ml/serving/fetch_weights.py --fix-only

Kết quả nằm ở /weights/futuretrace-qwen trong volume futuretrace-weights, đúng chỗ modal_app.py đọc.
"""

import os

import modal

image = modal.Image.debian_slim(python_version="3.12").pip_install("huggingface_hub[hf_transfer]==0.33.0").env(
    {"HF_HUB_ENABLE_HF_TRANSFER": "1"}
)
weights = modal.Volume.from_name("futuretrace-weights", create_if_missing=True)
app = modal.App("futuretrace-fetch-weights")

DEST = "/weights/futuretrace-qwen"
# Tokenizer không đổi khi fine-tune: dùng lại bản gốc của Qwen (cùng base model đã huấn luyện)
BASE_TOKENIZER = os.environ.get("BASE_TOKENIZER", "Qwen/Qwen3-4B-Instruct-2507")  # phải trùng base model đã huấn luyện
# generation_config.json gốc có tham số chống lặp của Qwen (repetition_penalty 1.05, top_p, top_k) mà bản transformers 5.x lưu bị mất
TOKENIZER_FILES = ["tokenizer_config.json", "tokenizer.json", "vocab.json", "merges.txt", "generation_config.json"]


def _make_vllm_compatible(dest, token):
    """transformers 5.x lưu tokenizer_config.json kiểu mới (extra_special_tokens dạng list, chat template tách ra
    chat_template.jinja); vLLM 0.9.x chạy transformers 4.x báo "'list' object has no attribute 'keys'".
    Thay bằng bộ tokenizer gốc của Qwen (có sẵn chat template trong tokenizer_config.json)."""
    import json
    import os
    from huggingface_hub import hf_hub_download

    for f in TOKENIZER_FILES:
        hf_hub_download(BASE_TOKENIZER, f, local_dir=dest, force_download=True, token=token)
    jinja = os.path.join(dest, "chat_template.jinja")
    if os.path.exists(jinja):
        os.remove(jinja)
    cfg_path = os.path.join(dest, "config.json")
    cfg = json.load(open(cfg_path))
    if "torch_dtype" not in cfg:  # transformers 5.x chỉ ghi "dtype"
        cfg["torch_dtype"] = cfg.get("dtype", "float16")
        json.dump(cfg, open(cfg_path, "w"), indent=2)
    tc = json.load(open(os.path.join(dest, "tokenizer_config.json")))
    assert isinstance(tc.get("extra_special_tokens", {}), dict) and tc.get("chat_template"), "tokenizer_config.json chưa đúng"
    print("Đã thay tokenizer gốc", BASE_TOKENIZER, "| torch_dtype =", cfg["torch_dtype"])
    print("generation_config:", " ".join(open(os.path.join(dest, "generation_config.json")).read().split()))


@app.function(image=image, volumes={"/weights": weights}, secrets=[modal.Secret.from_name("huggingface-token")], timeout=60 * 60)
def fetch(repo: str, fix_only: bool = False):
    import os
    from huggingface_hub import snapshot_download

    token = os.environ["HF_TOKEN"]
    if not fix_only:
        snapshot_download(repo_id=repo, local_dir=DEST, token=token)
    _make_vllm_compatible(DEST, token)
    weights.commit()
    files = sorted(os.listdir(DEST))
    print("Trong volume:", files)
    need = {"config.json", "tokenizer.json", "tokenizer_config.json", "model.safetensors.index.json"}
    missing = need - set(files)
    if missing or not any(f.endswith(".safetensors") for f in files):
        raise RuntimeError(f"Thiếu file: {missing or 'safetensors'}")


@app.local_entrypoint()
def main(repo: str = "", fix_only: bool = False):
    if not repo and not fix_only:
        raise SystemExit("Cần --repo TÊN/futuretrace-qwen (hoặc --fix-only nếu đã tải)")
    fetch.remote(repo, fix_only)
