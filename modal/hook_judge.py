import modal
from pydantic import BaseModel

BASE_MODEL = "Qwen/Qwen3.5-4B"
ADAPTER_MODEL = "lollygag/hook-judge-qwen3.5-4b"

app = modal.App("adtopia-hook-judge")
hf_cache = modal.Volume.from_name("hook-judge-hf-cache", create_if_missing=True)

image = (
    modal.Image.from_registry("nvidia/cuda:12.4.1-devel-ubuntu22.04", add_python="3.11")
    .apt_install("git", "build-essential")
    .pip_install(
        "torch",
        "transformers>=5.0.0,<6.0.0",
        "peft",
        "accelerate",
        "fastapi[standard]",
        "ninja",
        "packaging",
    )
    .run_commands(
        "pip install --no-build-isolation flash-linear-attention causal-conv1d",
        "pip uninstall -y torchao || true",
    )
)


class JudgeRequest(BaseModel):
    query: str
    a: str
    b: str


def format_prompt(query: str, caption_a: str, caption_b: str) -> str:
    return (
        f"Search: {query} (TikTok). Two videos from the same search, by creators of similar size. "
        "Which one got far more views relative to its creator's follower count? Answer with A or B only.\n"
        f"A: {caption_a}\n"
        f"B: {caption_b}"
    )


@app.cls(
    gpu="L4",
    image=image,
    scaledown_window=300,
    volumes={"/root/.cache/huggingface": hf_cache},
)
class HookJudge:
    @modal.enter()
    def load(self):
        import torch
        from peft import PeftModel
        from transformers import AutoModelForImageTextToText, AutoTokenizer

        self.tok = AutoTokenizer.from_pretrained(ADAPTER_MODEL)
        base = AutoModelForImageTextToText.from_pretrained(
            BASE_MODEL,
            dtype=torch.float16,
            device_map="cuda",
        )
        self.model = PeftModel.from_pretrained(base, ADAPTER_MODEL).eval()

    def _prefix(self, prompt: str) -> str:
        # Match the exact chat prefix seen in training right before the answer letter.
        a = self.tok.apply_chat_template(
            [{"role": "user", "content": prompt}, {"role": "assistant", "content": "A"}],
            tokenize=False,
        )
        b = self.tok.apply_chat_template(
            [{"role": "user", "content": prompt}, {"role": "assistant", "content": "B"}],
            tokenize=False,
        )
        n = next(i for i, (x, y) in enumerate(zip(a, b)) if x != y)
        return a[:n]

    def _judge(self, query: str, caption_a: str, caption_b: str) -> str:
        import torch

        prompt = format_prompt(query, caption_a, caption_b)
        enc = self.tok(
            self._prefix(prompt),
            return_tensors="pt",
            add_special_tokens=False,
        ).to(self.model.device)
        with torch.inference_mode():
            out = self.model.generate(
                **enc,
                max_new_tokens=2,
                do_sample=False,
                pad_token_id=self.tok.eos_token_id,
            )
        decoded = (
            self.tok.decode(
                out[0][enc["input_ids"].shape[-1] :],
                skip_special_tokens=True,
            )
            .strip()
            .upper()
        )
        for ch in decoded:
            if ch in ("A", "B"):
                return ch
        return "A"

    @modal.fastapi_endpoint(method="POST", requires_proxy_auth=True)
    def score(self, body: JudgeRequest) -> dict[str, str]:
        return {"answer": self._judge(body.query, body.a, body.b)}
