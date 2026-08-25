"""OpenRouter LLM client — shared by the app's AI features (channel tagging, …).

Thin wrapper around the OpenRouter chat-completions API. Config (key, base URL,
default model) lives in app.config.settings.
"""
from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator

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


def _record_usage(u: dict | None) -> None:
    """Fold one response's `usage` into the running tally, counting the call.

    Tolerant of a missing `usage` because the streaming path may not get one: it
    arrives in a final chunk the provider is free to omit, and a call that
    answered is still a call that happened.
    """
    usage_totals["calls"] += 1
    u = u or {}
    usage_totals["prompt_tokens"] += u.get("prompt_tokens", 0)
    usage_totals["completion_tokens"] += u.get("completion_tokens", 0)
    usage_totals["total_tokens"] += u.get("total_tokens", 0)


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
    _record_usage(data.get("usage"))
    # A 200 doesn't guarantee a completion: providers return null content when the
    # model emits only reasoning tokens, or gets cut off before writing any. Left
    # unguarded that None reaches the caller's .find() as an AttributeError, which
    # says nothing about what went wrong — and callers that degrade on failure
    # (video labels) can't tell it from a real empty answer.
    choices = data.get("choices") or []
    content = ((choices[0] or {}).get("message") or {}).get("content") if choices else None
    if not content:
        reason = (choices[0] or {}).get("finish_reason") if choices else None
        raise LLMError(f"empty reply from {body['model']} (finish_reason={reason})")
    return content


async def chat_stream(
    system: str,
    messages: list[dict],
    *,
    model: str | None = None,
    temperature: float = 0.3,
    max_tokens: int = 1200,
    timeout: float = 120,
    reasoning: bool = False,
    provider_sort: str | None = None,
) -> AsyncIterator[str]:
    """A multi-turn completion, yielded token by token as it arrives.

    A sibling of `chat()` rather than a mode of it, and async rather than
    blocking, because the two are used at opposite ends. `chat()` answers
    machine callers — tagging, translation — where nothing can start until the
    whole reply is parsed, so a blocking call in a thread pool is exactly right.
    This one answers a person watching the panel: what matters is when the FIRST
    word lands, and a reply that takes eight seconds to arrive whole is a reply
    that looked broken for seven of them.

    `messages` is the conversation WITHOUT the system turn (which is passed
    separately, as in `chat()`) — user/assistant alternating, oldest first.

    `reasoning` defaults off here, unlike `chat()`: a reader is watching an empty
    panel while the model thinks, and thinking is invisible to them. Ask for it
    explicitly on a question that earns the wait.

    Raises LLMError for a missing key or a non-200 — both before the first yield,
    so a caller can still turn them into an HTTP status. A stream that opens and
    then dies mid-answer raises too, but by then the caller has already sent
    tokens and can only stop.
    """
    if not settings.openrouter_api_key:
        raise LLMError("OPENROUTER_API_KEY is not set")
    body: dict = {
        "model": model or settings.llm_tagging_model,
        "messages": [{"role": "system", "content": system}, *messages],
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": True,
        # Ask for the token counts in a final chunk. Providers are free to skip
        # it, so `_record_usage` treats their absence as zero rather than a bug.
        "usage": {"include": True},
    }
    if not reasoning:
        body["reasoning"] = {"enabled": False}
    if provider_sort:
        body["provider"] = {"sort": provider_sort}

    said_something = False
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream(
                "POST",
                f"{settings.openrouter_base_url}/chat/completions",
                headers={"Authorization": f"Bearer {settings.openrouter_api_key}"},
                json=body,
            ) as resp:
                if resp.status_code != 200:
                    detail = (await resp.aread()).decode("utf-8", "replace")
                    raise LLMError(f"OpenRouter {resp.status_code}: {detail[:200]}")
                async for line in resp.aiter_lines():
                    # Keep-alive comments (": OPENROUTER PROCESSING") and the
                    # blank lines between events both land here and mean nothing.
                    if not line.startswith("data:"):
                        continue
                    payload = line[len("data:"):].strip()
                    if payload == "[DONE]":
                        break
                    try:
                        chunk = json.loads(payload)
                    except ValueError:
                        continue  # a partial frame; the next line carries the rest
                    if chunk.get("usage"):
                        _record_usage(chunk["usage"])
                    choices = chunk.get("choices") or []
                    delta = ((choices[0] or {}).get("delta") or {}).get("content") if choices else None
                    if delta:
                        said_something = True
                        yield delta
    except httpx.HTTPError as e:
        raise LLMError(f"request failed: {e!r}")

    if not said_something:
        # Same failure `chat()` guards: a 200 whose choices carry only reasoning
        # tokens, or nothing at all. Silence is not an empty answer.
        raise LLMError(f"empty reply from {body['model']}")


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
