"""
QLoRA fine-tune Qwen-Instruct cho FutureTrace (tác vụ T1, dữ liệu từ build_sft_dataset.js).

Chạy miễn phí trên Kaggle (GPU T4 16GB, ~30 giờ/tuần):
  1. Tạo Kaggle Dataset chứa train.jsonl, val.jsonl (thư mục data/sft_t1 sau khi chạy build_sft_dataset.js)
  2. Notebook mới -> Accelerator: GPU T4 x2 (hoặc P100) -> Add data -> dataset trên
  3. !pip install -q "unsloth" "trl>=0.19" datasets
     !python train_qlora.py --data /kaggle/input/<dataset> --base unsloth/Qwen2.5-7B-Instruct-bnb-4bit --out /kaggle/working/ft
  4. Tải /kaggle/working/ft-merged (cho Modal/vLLM) và ft-gguf (cho Ollama) về, rồi:
       modal volume put futuretrace-weights ./ft-merged /futuretrace-qwen
       modal deploy ml/serving/modal_app.py

Gợi ý: chạy thử với --base unsloth/Qwen2.5-3B-Instruct-bnb-4bit trước (nhanh gấp ~2 lần) và so sánh bằng
ml/eval/run_llm_eval.js; chọn model nhỏ nhất đạt ngưỡng chất lượng (JSON >= 99%, groundedness >= 98%,
rubric >= 90% của Gemini) để độ trễ và chi phí GPU thấp nhất.
"""

import argparse
import dataclasses
import inspect
import json
import os

import torch
from datasets import load_dataset
from trl import SFTConfig, SFTTrainer
from unsloth import FastLanguageModel
from unsloth.chat_templates import train_on_responses_only


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="thư mục chứa train.jsonl, val.jsonl")
    ap.add_argument("--base", default="unsloth/Qwen2.5-7B-Instruct-bnb-4bit")
    ap.add_argument("--out", default="ft")
    ap.add_argument("--epochs", type=float, default=2)
    ap.add_argument("--max-seq", type=int, default=6144)
    ap.add_argument("--rank", type=int, default=32)
    ap.add_argument("--no-gguf", action="store_true")
    args = ap.parse_args()

    # T4/P100 (compute capability < 8) không có bfloat16 thật: phải ép float16, nếu không gradient là bf16 và GradScaler fp16 báo lỗi
    use_bf16 = torch.cuda.get_device_capability()[0] >= 8
    dtype = torch.bfloat16 if use_bf16 else torch.float16
    print(f"[gpu] {torch.cuda.get_device_name(0)} dtype={dtype}")
    model, tokenizer = FastLanguageModel.from_pretrained(args.base, max_seq_length=args.max_seq, dtype=dtype, load_in_4bit=True)
    model = FastLanguageModel.get_peft_model(
        model, r=args.rank, lora_alpha=args.rank * 2, lora_dropout=0.0,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        use_gradient_checkpointing="unsloth", random_state=42,
    )

    # Tham số LoRA có thể bị tạo ở bfloat16 (theo config gốc của Qwen) -> gradient bf16 làm GradScaler fp16 lỗi trên T4.
    # Ép tham số huấn luyện (chỉ ~60M) về float32: cách chuẩn của QLoRA, tốn thêm rất ít bộ nhớ.
    if not use_bf16:
        for _, p in model.named_parameters():
            if p.requires_grad and p.dtype != torch.float32:
                p.data = p.data.float()
    kinds = {}
    for _, p in model.named_parameters():
        if p.requires_grad:
            kinds[str(p.dtype)] = kinds.get(str(p.dtype), 0) + p.numel()
    print(f"[dtype] tham số huấn luyện: {kinds}")

    ds = load_dataset("json", data_files={
        "train": os.path.join(args.data, "train.jsonl"),
        "eval": os.path.join(args.data, "val.jsonl"),
    })
    ds = ds.map(lambda ex: {"text": tokenizer.apply_chat_template(ex["messages"], tokenize=False)},
                remove_columns=["messages"])

    # Mẫu dài hơn max-seq sẽ bị cắt cụt (JSON thiếu đuôi) và dạy model sai: báo sớm
    lens = [len(tokenizer(t["text"], add_special_tokens=False)["input_ids"]) for t in ds["train"]]
    print(f"[token] train: max={max(lens)} trung vị={sorted(lens)[len(lens)//2]} giới hạn={args.max_seq} số mẫu vượt={sum(l > args.max_seq for l in lens)}")
    if max(lens) > args.max_seq:
        print("[CẢNH BÁO] có mẫu bị cắt cụt; tăng --max-seq (vd 8192) hoặc loại mẫu dài")

    # trl đổi tên tham số giữa các phiên bản: max_seq_length -> max_length, tokenizer -> processing_class
    cfg_params = {f.name for f in dataclasses.fields(SFTConfig)}
    seq_kw = {"max_length": args.max_seq} if "max_length" in cfg_params else {"max_seq_length": args.max_seq}
    tok_kw = {"processing_class": tokenizer} if "processing_class" in inspect.signature(SFTTrainer.__init__).parameters else {"tokenizer": tokenizer}
    # transformers 5.x bỏ warmup_ratio; warmup_steps nhận số thực trong [0,1) là tỷ lệ trên tổng số bước
    warm_kw = {"warmup_ratio": 0.05} if "warmup_ratio" in {f.name for f in dataclasses.fields(SFTConfig)} else {"warmup_steps": 0.05}
    # Dữ liệu nhỏ (~200 mẫu, ~40 bước): đánh giá/lưu mỗi 10 bước, không thì load_best_model_at_end không có checkpoint nào
    trainer = SFTTrainer(
        model=model,
        train_dataset=ds["train"],
        eval_dataset=ds["eval"],
        **tok_kw,
        args=SFTConfig(
            output_dir=args.out, dataset_text_field="text", **seq_kw,
            per_device_train_batch_size=1, gradient_accumulation_steps=16,
            num_train_epochs=args.epochs, learning_rate=1e-4, lr_scheduler_type="cosine",
            logging_steps=10, eval_strategy="steps", eval_steps=10,
            save_strategy="steps", save_steps=10, save_total_limit=2,
            load_best_model_at_end=True, metric_for_best_model="eval_loss",
            bf16=use_bf16, fp16=not use_bf16, seed=42, report_to="none",
            **warm_kw,
        ),
    )
    # Chỉ tính loss trên câu trả lời (JSON) của assistant, không học lại prompt
    trainer = train_on_responses_only(
        trainer,
        instruction_part="<|im_start|>user\n",
        response_part="<|im_start|>assistant\n",
    )
    stats = trainer.train()
    metrics = trainer.evaluate()
    with open(os.path.join(args.out, "train_metrics.json"), "w", encoding="utf-8") as f:
        json.dump({"train": stats.metrics, "eval": metrics, "base": args.base, "rank": args.rank}, f, indent=2)

    model.save_pretrained(os.path.join(args.out, "lora"))
    tokenizer.save_pretrained(os.path.join(args.out, "lora"))
    # Bản merged 16-bit cho vLLM (Modal); GGUF Q4_K_M cho Ollama (demo offline trên laptop)
    model.save_pretrained_merged(f"{args.out}-merged", tokenizer, save_method="merged_16bit")
    if not args.no_gguf:
        model.save_pretrained_gguf(f"{args.out}-gguf", tokenizer, quantization_method="q4_k_m")


if __name__ == "__main__":
    main()
