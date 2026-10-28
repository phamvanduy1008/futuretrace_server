"""
QLoRA fine-tune Qwen-Instruct cho FutureTrace bằng transformers + peft + bitsandbytes (KHÔNG dùng Unsloth/trl).

Vì sao có bản này: Unsloth/trl bản mới đổi API liên tục và trên T4 làm gradient bị bfloat16 (T4 không có bf16 thật).
Bản này chỉ dùng API ổn định, theo công thức QLoRA chuẩn cho T4: nền 4-bit NF4, tính toán float16, LoRA float32.

Kaggle (GPU T4 x2 hoặc P100):
  !pip install -q -U "bitsandbytes>=0.46" peft accelerate datasets
  !python /kaggle/input/datasets/<tài-khoản>/futuretrace-sft/train_qlora_hf.py \
      --data /kaggle/input/datasets/<tài-khoản>/futuretrace-sft --out /kaggle/working/ft3b --epochs 3

Đầu ra: <out>/lora (adapter), <out>-merged (fp16, dùng cho Modal/vLLM), <out>/train_metrics.json.
Kiểm tra không cần GPU: --smoke (model ngẫu nhiên rất nhỏ, chạy CPU vài chục giây).
"""

import os

# Chỉ dùng 1 GPU: 4-bit + DataParallel (2 GPU) không tương thích. Phải đặt trước khi import torch.
os.environ.setdefault("CUDA_VISIBLE_DEVICES", "0")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import argparse
import dataclasses
import gc
import json
import sys

import torch
from datasets import load_dataset
from transformers import AutoModelForCausalLM, AutoTokenizer, Trainer, TrainingArguments

for _s in (sys.stdout, sys.stderr):  # tránh UnicodeEncodeError khi console không phải UTF-8 (Windows)
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

ASSISTANT_MARK = "<|im_start|>assistant\n"
END_MARK = "<|im_end|>"
TARGET_MODULES = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]


def load_model(name, dtype, **kw):
    """transformers 4.5x dùng torch_dtype, 5.x dùng dtype."""
    try:
        return AutoModelForCausalLM.from_pretrained(name, dtype=dtype, **kw)
    except TypeError:
        return AutoModelForCausalLM.from_pretrained(name, torch_dtype=dtype, **kw)


def encode(tokenizer, messages, max_seq):
    """Mã hóa 1 hội thoại; nhãn chỉ ở phần trả lời của assistant (kèm <|im_end|>), phần còn lại = -100."""
    text = tokenizer.apply_chat_template(messages, tokenize=False)
    start = text.rfind(ASSISTANT_MARK)
    if start < 0 or text.count(ASSISTANT_MARK) != 1:
        return None
    resp_start = start + len(ASSISTANT_MARK)
    resp_end = text.find(END_MARK, resp_start)
    if resp_end < 0:
        return None
    resp_end += len(END_MARK)
    enc = tokenizer(text, add_special_tokens=False, return_offsets_mapping=True)
    ids = enc["input_ids"]
    if len(ids) > max_seq:
        return None
    labels = [tid if (s >= resp_start and e <= resp_end and e > s) else -100
              for tid, (s, e) in zip(ids, enc["offset_mapping"])]
    if not any(l != -100 for l in labels):
        return None
    return {"input_ids": ids, "attention_mask": [1] * len(ids), "labels": labels}


def build_dataset(tokenizer, path, max_seq, name):
    rows, dropped = [], 0
    with open(path, encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            ex = encode(tokenizer, json.loads(line)["messages"], max_seq)
            if ex is None:
                dropped += 1
            else:
                rows.append(ex)
    if not rows:
        raise SystemExit(f"[data] {name}: không có mẫu nào hợp lệ trong {path}")
    lens = sorted(len(r["input_ids"]) for r in rows)
    sup = sum(sum(1 for l in r["labels"] if l != -100) for r in rows)
    print(f"[data] {name}: {len(rows)} mẫu, bỏ {dropped}; token max={lens[-1]} trung vị={lens[len(lens) // 2]}; "
          f"token có nhãn (assistant) = {sup} / {sum(lens)}")
    if dropped:
        print(f"[CẢNH BÁO] {name}: {dropped} mẫu bị bỏ (quá dài hơn --max-seq hoặc sai định dạng)")
    return rows


def make_collator(pad_id):
    def collate(batch):
        n = max(len(b["input_ids"]) for b in batch)
        pad = lambda seq, v: seq + [v] * (n - len(seq))
        return {
            "input_ids": torch.tensor([pad(b["input_ids"], pad_id) for b in batch]),
            "attention_mask": torch.tensor([pad(b["attention_mask"], 0) for b in batch]),
            "labels": torch.tensor([pad(b["labels"], -100) for b in batch]),
        }
    return collate


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="thư mục chứa train.jsonl, val.jsonl")
    # Qwen3-4B-Instruct-2507: chỉ văn bản, Apache 2.0, kiến trúc attention chuẩn chạy được trên T4 (Qwen3.5-4B là đa phương thức + linear attention)
    ap.add_argument("--base", default="Qwen/Qwen3-4B-Instruct-2507")
    ap.add_argument("--out", default="ft")
    ap.add_argument("--epochs", type=float, default=3)
    ap.add_argument("--max-seq", type=int, default=6144)
    ap.add_argument("--rank", type=int, default=16)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--grad-accum", type=int, default=16)
    ap.add_argument("--no-merge", action="store_true", help="chỉ lưu adapter, không gộp thành model đầy đủ")
    ap.add_argument("--no-sample", action="store_true", help="bỏ bước sinh thử 1 mẫu sau khi huấn luyện")
    ap.add_argument("--smoke", action="store_true", help="kiểm tra luồng bằng model ngẫu nhiên nhỏ trên CPU")
    ap.add_argument("--no-4bit", action="store_true", help="LoRA trên bf16 đầy đủ (A100/H100), không lượng tử hóa")
    ap.add_argument("--init-adapter", default=None, help="khởi đầu từ adapter LoRA có sẵn (vd adapter mô phỏng v3) thay vì từ 0")
    ap.add_argument("--batch", type=int, default=1, help="batch mỗi GPU (H100: 4-8)")
    ap.add_argument("--eval-steps", type=int, default=10)
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    cuda = torch.cuda.is_available() and not args.smoke
    if not cuda and not args.smoke:
        raise SystemExit("Không thấy GPU: bật Accelerator = GPU T4 x2 (hoặc P100) trong Session options rồi chạy lại.")

    tokenizer = AutoTokenizer.from_pretrained(args.base)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    train_ds = build_dataset(tokenizer, os.path.join(args.data, "train.jsonl"), args.max_seq, "train")
    eval_ds = build_dataset(tokenizer, os.path.join(args.data, "val.jsonl"), args.max_seq, "val")
    if args.smoke:
        train_ds, eval_ds = train_ds[:6], eval_ds[:2]

    # T4/P100 (compute capability < 8) không có bfloat16: dùng float16 (QLoRA gốc cũng làm vậy)
    use_bf16 = cuda and torch.cuda.get_device_capability()[0] >= 8
    compute_dtype = torch.bfloat16 if use_bf16 else torch.float16
    print(f"[gpu] {torch.cuda.get_device_name(0) if cuda else 'CPU (smoke)'} compute_dtype={compute_dtype}")

    from peft import LoraConfig, PeftModel, get_peft_model, prepare_model_for_kbit_training

    base_name = args.base
    if args.smoke:
        from transformers import Qwen2Config, AutoConfig
        cfg = Qwen2Config(vocab_size=len(tokenizer), hidden_size=64, intermediate_size=128, num_hidden_layers=2,
                          num_attention_heads=4, num_key_value_heads=2, max_position_embeddings=args.max_seq,
                          tie_word_embeddings=True)
        tiny = AutoModelForCausalLM.from_config(cfg)
        base_name = os.path.join(args.out, "tiny_base")
        tiny.save_pretrained(base_name)
        tokenizer.save_pretrained(base_name)
        model = load_model(base_name, torch.float32)
    elif args.no_4bit:
        # GPU lớn (A100/H100): LoRA trên trọng số bf16 đầy đủ, nhanh hơn và không lệch khi gộp (không qua 4-bit)
        model = load_model(base_name, compute_dtype, device_map={"": 0}, attn_implementation="sdpa")
        model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
        model.enable_input_require_grads()
    else:
        from transformers import BitsAndBytesConfig
        bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                                 bnb_4bit_compute_dtype=compute_dtype, bnb_4bit_use_double_quant=True)
        model = load_model(base_name, compute_dtype, quantization_config=bnb, device_map={"": 0},
                           attn_implementation="sdpa")
        model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True,
                                                gradient_checkpointing_kwargs={"use_reentrant": False})
    model.config.use_cache = False

    lora = LoraConfig(r=args.rank, lora_alpha=args.rank * 2, lora_dropout=0.0, bias="none",
                      target_modules=TARGET_MODULES, task_type="CAUSAL_LM")
    if args.init_adapter:
        # Adapter mới thừa hưởng văn phong/cách dùng slot của adapter cũ; adapter cũ trên đĩa không bị sửa
        model = PeftModel.from_pretrained(model, args.init_adapter, is_trainable=True)
        print(f"[lora] khởi đầu từ adapter {args.init_adapter}")
    else:
        model = get_peft_model(model, lora)
    # Tham số huấn luyện phải là float32 (GradScaler fp16 không chịu gradient bf16/fp16)
    for _, p in model.named_parameters():
        if p.requires_grad and p.dtype != torch.float32:
            p.data = p.data.float()
    kinds = {}
    for _, p in model.named_parameters():
        if p.requires_grad:
            kinds[str(p.dtype)] = kinds.get(str(p.dtype), 0) + p.numel()
    print(f"[dtype] tham số huấn luyện: {kinds}")
    model.print_trainable_parameters()

    ta_fields = {f.name for f in dataclasses.fields(TrainingArguments)}
    warm = {"warmup_ratio": 0.05} if "warmup_ratio" in ta_fields else {"warmup_steps": 0.05}  # 5.x: số thực <1 = tỷ lệ
    targs = TrainingArguments(
        output_dir=os.path.join(args.out, "trainer"),
        per_device_train_batch_size=args.batch, per_device_eval_batch_size=args.batch,
        gradient_accumulation_steps=args.grad_accum if not args.smoke else 2,
        num_train_epochs=args.epochs if not args.smoke else 1,
        learning_rate=args.lr, lr_scheduler_type="cosine", max_grad_norm=1.0,
        logging_steps=5, eval_strategy="steps", eval_steps=args.eval_steps if not args.smoke else 2,
        save_strategy="no", report_to="none", seed=42, optim="adamw_torch",
        fp16=cuda and not use_bf16, bf16=use_bf16,
        remove_unused_columns=False, dataloader_num_workers=0, use_cpu=not cuda,
        **warm,
    )
    trainer = Trainer(model=model, args=targs, train_dataset=train_ds, eval_dataset=eval_ds,
                      data_collator=make_collator(tokenizer.pad_token_id))
    stats = trainer.train()
    metrics = trainer.evaluate()
    print(f"[eval] {metrics}")
    losses = [h["loss"] for h in trainer.state.log_history if "loss" in h]
    if losses and any(l != l for l in losses):
        print("[CẢNH BÁO] loss = NaN: có thể do tràn số float16; giảm --lr xuống 5e-5 hoặc chạy lại")

    with open(os.path.join(args.out, "train_metrics.json"), "w", encoding="utf-8") as f:
        json.dump({"train": stats.metrics, "eval": metrics, "log_history": trainer.state.log_history,
                   "base": args.base, "rank": args.rank, "n_train": len(train_ds), "n_val": len(eval_ds)},
                  f, indent=2, ensure_ascii=False)
    lora_dir = os.path.join(args.out, "lora")
    model.save_pretrained(lora_dir)
    tokenizer.save_pretrained(lora_dir)
    print(f"[lưu] adapter -> {lora_dir}")

    if not args.no_sample:
        # Sinh thử 1 hồ sơ val: xem model có ra JSON đúng cấu trúc không
        try:
            ex = json.loads(open(os.path.join(args.data, "val.jsonl"), encoding="utf-8").readline())["messages"][:2]
            prompt = tokenizer.apply_chat_template(ex, tokenize=False, add_generation_prompt=True)
            enc = tokenizer(prompt, return_tensors="pt", add_special_tokens=False).to(model.device)
            model.eval()
            if hasattr(model, "gradient_checkpointing_disable"):
                model.gradient_checkpointing_disable()
            model.config.use_cache = True
            with torch.no_grad():
                out = model.generate(**enc, max_new_tokens=2200 if not args.smoke else 16, do_sample=False,
                                     pad_token_id=tokenizer.pad_token_id)
            gen = tokenizer.decode(out[0][enc["input_ids"].shape[1]:], skip_special_tokens=True)
            try:
                j = json.loads(gen)
                ok = isinstance(j, dict) and len(j.get("scenarios", [])) == 3
                print(f"[sinh thử] JSON hợp lệ: True, đủ 3 kịch bản: {ok}")
            except Exception as e:
                print(f"[sinh thử] JSON hợp lệ: False ({e})")
            print("[sinh thử] 400 ký tự đầu:", gen[:400].replace("\n", " "))
        except Exception as e:  # không để bước phụ làm hỏng cả lần chạy
            print(f"[sinh thử] bỏ qua do lỗi: {e}")

    if args.no_merge:
        return
    # Gộp adapter vào bản fp16 đầy đủ (không phải 4-bit) cho vLLM/Modal
    del trainer, model
    gc.collect()
    if cuda:
        torch.cuda.empty_cache()
    base = load_model(base_name, torch.float16 if not args.smoke else torch.float32, low_cpu_mem_usage=True)
    merged = PeftModel.from_pretrained(base, lora_dir).merge_and_unload()
    merged_dir = f"{args.out}-merged"
    merged.save_pretrained(merged_dir, safe_serialization=True, max_shard_size="5GB")
    tokenizer.save_pretrained(merged_dir)
    print(f"[lưu] model đã gộp -> {merged_dir}")


if __name__ == "__main__":
    main()
