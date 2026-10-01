"""llm.chat_stream against a fake OpenRouter: how a stream ends."""

import json

import httpx
import pytest

from app import llm, runtime_config


def sse(*chunks: dict) -> bytes:
    return "".join(f"data: {json.dumps(c)}\n\n" for c in chunks).encode() + b"data: [DONE]\n\n"


def piece(text: str, finish: str | None = None) -> dict:
    return {"choices": [{"delta": {"content": text}, "finish_reason": finish}]}


@pytest.fixture
def openrouter(monkeypatch):
    """Serve `reply["body"]` as the completion stream."""
    reply = {}
    real = httpx.AsyncClient
    transport = httpx.MockTransport(lambda request: httpx.Response(200, content=reply["body"]))
    monkeypatch.setattr(llm.httpx, "AsyncClient", lambda **kw: real(transport=transport, **kw))
    monkeypatch.setattr(runtime_config, "openrouter_api_key", lambda: "sk-test")
    return reply


async def test_an_answer_that_finishes_arrives_whole(openrouter):
    openrouter["body"] = sse(piece("It went "), piece("up.", "stop"))
    assert "".join([d async for d in llm.chat_stream("sys", [])]) == "It went up."


async def test_an_answer_cut_off_by_the_token_cap_says_so_after_the_text(openrouter):
    """Stopped by max_tokens, a reply ends mid-sentence and reads as complete.
    The text still arrives; the stream then raises, so the caller marks it."""
    openrouter["body"] = sse(piece("Section one. "), piece("Section tw", "length"))
    got = []
    with pytest.raises(llm.LLMError, match="limit"):
        async for d in llm.chat_stream("sys", [], max_tokens=40):
            got.append(d)
    assert "".join(got) == "Section one. Section tw"
