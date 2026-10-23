"""Caption post-processing — the parts that run before and after the LLM —
and the track download they all start from.

`_to_sentences` is what makes translation work at all (fragments can't be
translated 1:1 because word order moves across languages), and `_parse_numbered`
is what decides whether a reply is trustworthy enough to use.
"""

import pytest

from app.routers.feed import _parse_numbered, _to_sentences


def cue(start, dur, text, words=None):
    c = {"start": start, "dur": dur, "text": text}
    if words is not None:
        c["words"] = words
    return c


def w(t, text):
    return {"t": t, "text": text}


# ── _to_sentences ────────────────────────────────────────────────────


def test_no_cues_is_no_sentences():
    assert _to_sentences([]) == []


def test_fragments_are_joined_into_whole_sentences():
    """The point of the whole function: a sentence split across two cues has to
    come out as one unit, or the translation has to choose between natural word
    order and the line count."""
    cues = [
        cue(0.0, 2.0, "create time and space"),
        cue(2.0, 2.0, "for her own exploration."),
        cue(4.0, 2.0, "Then she left."),
    ]
    out = _to_sentences(cues)
    assert [s["text"] for s in out] == [
        "create time and space for her own exploration.",
        "Then she left.",
    ]


def test_sentences_span_from_their_start_to_the_next_one():
    cues = [cue(0.0, 2.0, "One."), cue(5.0, 3.0, "Two.")]
    out = _to_sentences(cues)
    assert out[0]["start"] == 0.0
    assert out[0]["end"] == 5.0
    # The last one runs to the end of the final cue.
    assert out[1]["end"] == 8.0


def test_an_unpunctuated_track_keeps_one_cue_per_line():
    """Chinese ASR often has no sentence punctuation at all — there is nothing
    to group on, and each cue is already a standalone phrase."""
    cues = [cue(0.0, 2.0, "今天我們來看看"), cue(2.0, 2.0, "這家店的招牌菜")]
    out = _to_sentences(cues)
    assert [s["text"] for s in out] == ["今天我們來看看", "這家店的招牌菜"]


def test_cjk_sentence_punctuation_still_groups():
    cues = [cue(0.0, 2.0, "今天我們來看看"), cue(2.0, 2.0, "這家店的招牌菜。")]
    assert [s["text"] for s in _to_sentences(cues)] == ["今天我們來看看這家店的招牌菜。"]


def test_cjk_words_are_joined_without_a_space():
    """A space between Han characters is visible and wrong."""
    cues = [cue(0.0, 2.0, "很好吃。", words=[{"t": 0.0, "text": "很好"}, {"t": 1.0, "text": "吃。"}])]
    assert _to_sentences(cues)[0]["text"] == "很好吃。"


def test_latin_words_are_joined_with_a_space():
    cues = [cue(0.0, 2.0, "so good.", words=[{"t": 0.0, "text": "so"}, {"t": 1.0, "text": "good."}])]
    assert _to_sentences(cues)[0]["text"] == "so good."


def test_a_words_own_leading_space_is_not_doubled():
    cues = [cue(0.0, 2.0, "so good.", words=[{"t": 0.0, "text": "so"}, {"t": 1.0, "text": " good."}])]
    assert _to_sentences(cues)[0]["text"] == "so good."


def test_sentences_are_segmented_on_the_word_stream_not_the_cue():
    """Rolling captions put the sentence end mid-cue, so splitting per cue would
    glue the next sentence's opening onto the previous one."""
    cues = [
        cue(0.0, 4.0, "One. Two", words=[
            {"t": 0.0, "text": "One."},
            {"t": 1.0, "text": "Two"},
        ]),
        cue(4.0, 2.0, "more.", words=[{"t": 4.0, "text": "more."}]),
    ]
    out = _to_sentences(cues)
    assert [s["text"] for s in out] == ["One.", "Two more."]
    assert out[1]["start"] == 1.0  # the timing follows the word, not the cue


def test_a_trailing_fragment_is_kept():
    """A track that ends mid-sentence must not lose its last words."""
    cues = [cue(0.0, 2.0, "Done."), cue(2.0, 2.0, "and then")]
    assert [s["text"] for s in _to_sentences(cues)] == ["Done.", "and then"]


def test_a_closing_quote_after_the_stop_still_ends_the_sentence():
    cues = [cue(0.0, 2.0, '"Stop it."'), cue(2.0, 2.0, "She left.")]
    assert len(_to_sentences(cues)) == 2


def test_empty_cues_are_dropped():
    cues = [cue(0.0, 2.0, "  "), cue(2.0, 2.0, "Real text")]
    assert [s["text"] for s in _to_sentences(cues)] == ["Real text"]


def test_a_title_does_not_end_a_sentence():
    """ "…channels like Mr." and "Beast and Fireship came in…" went to the model
    as two lines, and it joined them."""
    cues = [
        cue(0.0, 2.0, "before channels like Mr.", [w(0.0, "before"), w(0.5, " channels"), w(1.0, " like"), w(1.5, " Mr.")]),
        cue(2.0, 2.0, "Beast came in. Then", [w(2.0, " Beast"), w(2.5, " came"), w(3.0, " in."), w(3.5, " Then")]),
    ]
    assert [s["text"] for s in _to_sentences(cues)] == [
        "before channels like Mr. Beast came in.", "Then",
    ]
    # As it split before, which a row numbered against that split is read by.
    assert len(_to_sentences(cues, legacy=True)) == 3


@pytest.mark.parametrize("abbr", ["Dr.", "Mrs.", "vs.", "e.g."])
def test_other_abbreviations_do_not_end_a_sentence(abbr):
    words = [w(0.0, "see"), w(0.5, f" {abbr}"), w(1.0, " Smith."), w(1.5, " Next.")]
    cues = [cue(0.0, 2.0, f"see {abbr} Smith. Next.", words)]
    assert [s["text"] for s in _to_sentences(cues)] == [f"see {abbr} Smith.", "Next."]


# ── _parse_numbered ──────────────────────────────────────────────────


def test_a_clean_reply_parses():
    assert _parse_numbered("1. first\n2. second\n3. third", 3) == {
        1: "first", 2: "second", 3: "third"
    }


@pytest.mark.parametrize("sep", [".", ")", ":", "、"])
def test_the_separators_models_actually_use(sep):
    assert _parse_numbered(f"1{sep} first\n2{sep} second", 2) == {1: "first", 2: "second"}


def test_stray_prose_around_the_list_is_ignored():
    raw = "Here is the translation:\n1. first\n2. second\nHope that helps!"
    assert _parse_numbered(raw, 2) == {1: "first", 2: "second"}


def test_numbers_outside_the_batch_are_dropped():
    """A model that keeps counting past the batch would otherwise write into
    lines that don't exist."""
    assert _parse_numbered("1. first\n2. second\n9. nope", 2) == {1: "first", 2: "second"}


def test_a_reply_with_a_gap_is_accepted():
    """A line dropped from the middle leaves the others' numbers right."""
    got = _parse_numbered("1. a\n2. b\n4. d\n5. e\n6. f\n7. g\n8. h\n10. j", 10)
    assert got is not None and len(got) == 8


def test_a_reply_short_at_the_end_is_rejected():
    """What a model that joined two lines and renumbered the rest sends: every
    line after the join answers the number before its own. Taken, each
    translation showed one sentence late from there to the end."""
    assert _parse_numbered("1. a\n2. b\n3. c\n4. d\n5. e\n6. f\n7. g\n8. h\n9. i", 10) is None


def test_too_little_back_is_rejected_so_the_caller_can_retry():
    """Returning a half-empty dict would leave most of a stretch untranslated
    and cached that way."""
    assert _parse_numbered("1. only one", 10) is None
    assert _parse_numbered("no numbered lines here", 5) is None
    assert _parse_numbered("", 5) is None


# ── downloading the track ────────────────────────────────────────────


def _failing(times, monkeypatch):
    """A track download that fails `times` times, then returns one cue."""
    from app.routers import feed
    calls = []

    def _parse(url):
        calls.append(url)
        if len(calls) <= times:
            raise OSError("HTTP Error 429: Too Many Requests")
        return [cue(0.0, 1.0, "hello")]

    monkeypatch.setattr(feed, "_parse_json3", _parse)
    monkeypatch.setattr(feed, "_JSON3_RETRY_DELAYS", (0, 0))
    return calls


def test_a_track_download_that_fails_once_is_retried(monkeypatch):
    """One 429 used to mean no captions — and no Chinese built on them — for
    the five minutes a failure stays cached."""
    from app.routers.feed import _parse_json3_retrying
    calls = _failing(1, monkeypatch)
    assert [c["text"] for c in _parse_json3_retrying("u")] == ["hello"]
    assert len(calls) == 2


def test_a_track_that_keeps_failing_gives_up(monkeypatch):
    from app.routers.feed import _parse_json3_retrying
    calls = _failing(99, monkeypatch)
    with pytest.raises(OSError):
        _parse_json3_retrying("u")
    assert len(calls) == 3
