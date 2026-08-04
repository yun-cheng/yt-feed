"""Caption post-processing — the parts that run before and after the LLM.

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
    assert _parse_numbered("1. first\n9. nope", 2) == {1: "first"}


def test_a_mostly_complete_reply_is_accepted():
    """Below-100% is normal and the caller fills the gaps with the source line."""
    got = _parse_numbered("1. a\n2. b\n3. c\n4. d\n5. e\n6. f\n7. g\n8. h", 10)
    assert got is not None and len(got) == 8


def test_too_little_back_is_rejected_so_the_caller_can_retry():
    """Returning a half-empty dict would leave most of a stretch untranslated
    and cached that way."""
    assert _parse_numbered("1. only one", 10) is None
    assert _parse_numbered("no numbered lines here", 5) is None
    assert _parse_numbered("", 5) is None
