"""OpenRouter LLM client — shared by the app's AI features (channel tagging, …).

Thin wrapper around the OpenRouter chat-completions API. Config (key, base URL,
default model) lives in app.config.settings.
"""
from __future__ import annotations

import json
import re

import httpx

from app.config import settings


class LLMError(Exception):
    pass


# Process-wide token tally, accumulated from each response's `usage`. Cheap
# observability for the LLM features (channel tagging, video labeling); read it
# after a batch of calls to see how many tokens they cost.
usage_totals = {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}


def reset_usage() -> None:
    for k in usage_totals:
        usage_totals[k] = 0


def chat(
    system: str,
    user: str,
    *,
    model: str | None = None,
    temperature: float = 0,
    max_tokens: int = 2000,
    timeout: float = 90,
    reasoning: bool = True,
    provider_sort: str | None = None,
) -> str:
    """One-shot chat completion. Returns the assistant message text.

    `reasoning=False` asks the provider to skip chain-of-thought. Worth setting
    for mechanical work (translation, extraction): reasoning models otherwise
    spend 4-6x the output budget thinking before they answer — measured 2,769
    reasoning tokens to produce 480 tokens of translation — which is both the
    dominant cost and the dominant latency. Whether it fires at all is provider-
    dependent, so leaving it on also makes timings unpredictable.

    `provider_sort` pins OpenRouter to one provider instead of spreading across
    all of them. That spread is the single biggest source of latency variance
    here: the same 40-line request measured 5s on Baidu and 212s on Ambient.

    Prefer `"latency"` over `"throughput"` for short bursts like a caption batch
    (~170 output tokens), where time-to-first-token dominates and tokens/sec
    barely matters. Which provider each sort lands on drifts day to day, and
    "fastest at streaming a long answer" is not "quickest to answer": measured
    over 5 calls of the same batch, throughput sorting (StreamLake / Novita) ran
    a 10.2s median / 20.5s max, while latency sorting (Parasail) held 4.4s /
    9.5s.

    Raises LLMError if the key is missing or the API doesn't return 200.
    """
    if not settings.openrouter_api_key:
        raise LLMError("OPENROUTER_API_KEY is not set")
    body: dict = {
        "model": model or settings.llm_tagging_model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if not reasoning:
        body["reasoning"] = {"enabled": False}
    if provider_sort:
        body["provider"] = {"sort": provider_sort}
    try:
        resp = httpx.post(
            f"{settings.openrouter_base_url}/chat/completions",
            headers={"Authorization": f"Bearer {settings.openrouter_api_key}"},
            json=body,
            timeout=timeout,
        )
    except httpx.HTTPError as e:
        raise LLMError(f"request failed: {e!r}")
    if resp.status_code != 200:
        raise LLMError(f"OpenRouter {resp.status_code}: {resp.text[:200]}")
    data = resp.json()
    u = data.get("usage") or {}
    usage_totals["calls"] += 1
    usage_totals["prompt_tokens"] += u.get("prompt_tokens", 0)
    usage_totals["completion_tokens"] += u.get("completion_tokens", 0)
    usage_totals["total_tokens"] += u.get("total_tokens", 0)
    return data["choices"][0]["message"]["content"]


def chat_json(system: str, user: str, **kw) -> dict:
    """chat() that returns parsed JSON.

    Tolerant of code fences and surrounding prose — models don't reliably honour
    a JSON response format — by extracting the outermost {...}. Also repairs the
    one malformation they emit often enough to matter: a trailing comma before a
    closing brace/bracket. The repair only runs after a strict parse fails, so it
    can't corrupt otherwise-valid replies.
    """
    text = chat(system, user, **kw)
    i, j = text.find("{"), text.rfind("}")
    if i < 0 or j <= i:
        raise LLMError(f"no JSON object in reply: {text[:160]!r}")
    blob = text[i:j + 1]
    try:
        return json.loads(blob)
    except json.JSONDecodeError:
        return json.loads(re.sub(r",\s*([}\]])", r"\1", blob))
