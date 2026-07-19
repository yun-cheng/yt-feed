"""OpenRouter LLM client — shared by the app's AI features (channel tagging, …).

Thin wrapper around the OpenRouter chat-completions API. Config (key, base URL,
default model) lives in app.config.settings.
"""
from __future__ import annotations

import json

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
) -> str:
    """One-shot chat completion. Returns the assistant message text.

    Raises LLMError if the key is missing or the API doesn't return 200.
    """
    if not settings.openrouter_api_key:
        raise LLMError("OPENROUTER_API_KEY is not set")
    try:
        resp = httpx.post(
            f"{settings.openrouter_base_url}/chat/completions",
            headers={"Authorization": f"Bearer {settings.openrouter_api_key}"},
            json={
                "model": model or settings.llm_tagging_model,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                "temperature": temperature,
                "max_tokens": max_tokens,
            },
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

    Tolerant of code fences and surrounding prose — free models don't reliably
    honour a JSON response format — by extracting the outermost {...}.
    """
    text = chat(system, user, **kw)
    i, j = text.find("{"), text.rfind("}")
    if i < 0 or j <= i:
        raise LLMError(f"no JSON object in reply: {text[:160]!r}")
    return json.loads(text[i:j + 1])
