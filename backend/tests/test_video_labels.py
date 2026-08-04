"""The deterministic half of per-channel video labelling.

Everything the LLM decides is out of scope here; everything applied around it —
match keys, stop words, the verbatim backstop, canonicalization — is not, and
is what keeps a wobbly labeller from producing wobbly chips.
"""

import json

import pytest

from app.models import Channel
from app.video_labels import (
    LABEL_VERSION,
    MAX_LABELS,
    _canonical,
    _channel_stops,
    _dedupe,
    _key,
    _labels_or_empty,
    _normalize,
    _verbatim,
    is_current,
)


# ── _key: the identity of a label ────────────────────────────────────


@pytest.mark.parametrize(
    "a,b",
    [
        ("League of Legends", "league of legends"),
        ("League of Legends", "leagueoflegends"),
        ("hip-hop", "hip hop"),
        ("FIFA世界盃", "FIFA 世界盃"),
        ("T1", "t1"),
    ],
)
def test_labels_that_should_be_one_label(a, b):
    assert _key(a) == _key(b)


def test_labels_that_should_stay_distinct():
    assert _key("football") != _key("footballer")
    assert _key("MLB") != _key("NBA")


def test_key_keeps_cjk():
    """Stripping CJK would collapse every Chinese label to the empty string, and
    with it every Chinese chip into one."""
    assert _key("世界盃") == "世界盃"
    assert _key("紐西蘭") != _key("世界盃")


# ── Stop words ───────────────────────────────────────────────────────


def test_global_stops_cover_languages_and_generic_descriptors():
    stops = _channel_stops(None, [])
    for label in ("chinese", "Japanese", "vlog", "Entertainment", "shorts"):
        assert _key(label) in stops


def test_a_channels_own_tags_become_stops():
    """An esports channel labelling every video `esports` says nothing."""
    stops = _channel_stops(None, ["esports", "gaming"])
    assert _key("esports") in stops
    assert _key("Esports") in stops


def test_stored_blanket_subjects_become_stops():
    ch = Channel(youtube_id="c", title="An LoL channel",
                 label_stop_words=json.dumps(["League of Legends"]))
    stops = _channel_stops(ch, [])
    assert _key("league of legends") in stops
    # Matched space-insensitively, so writing it differently can't slip through.
    assert _key("LeagueOfLegends") in stops


def test_corrupt_stop_words_degrade_to_the_global_list():
    ch = Channel(youtube_id="c", title="x", label_stop_words="not json")
    stops = _channel_stops(ch, ["esports"])
    assert _key("esports") in stops
    assert _key("vlog") in stops


# ── _verbatim: the backstop for the labeller's recall ────────────────


def test_verbatim_finds_vocabulary_terms_written_in_the_title():
    vocab = ["DK", "G2", "LCK", "League of Legends"]
    assert set(_verbatim("DK vs G2 | 2026 LCK", vocab, set())) == {"DK", "G2", "LCK"}


def test_verbatim_respects_ascii_word_boundaries():
    """`AL` must not fire inside `GAL` — an acronym vocabulary is full of these."""
    assert _verbatim("GAL highlights", ["AL"], set()) == []
    assert _verbatim("AL highlights", ["AL"], set()) == ["AL"]
    assert _verbatim("T1 wins", ["T1"], set()) == ["T1"]
    assert _verbatim("ST1CK", ["T1"], set()) == []


def test_verbatim_matches_ascii_case_insensitively():
    assert _verbatim("mlb tonight", ["MLB"], set()) == ["MLB"]


def test_verbatim_matches_cjk_as_a_substring():
    """CJK has no word boundaries to anchor to."""
    assert _verbatim("2026世界盃四強", ["世界盃"], set()) == ["世界盃"]


def test_verbatim_never_returns_a_stopped_label():
    stops = {_key("League of Legends")}
    # Both are written in the title and both are in the vocabulary; only the
    # stopped one is withheld.
    assert _verbatim("League of Legends finals", ["League of Legends", "finals"], stops) == ["finals"]


def test_verbatim_of_an_unrelated_title_is_empty():
    assert _verbatim("A cooking video", ["MLB", "NBA"], set()) == []


# ── Canonicalization ─────────────────────────────────────────────────


def test_canonical_snaps_to_the_vocabularys_casing():
    """Chip text and stored labels have to be identical or filtering misses."""
    assert _canonical(["league of legends", "t1"], ["League of Legends", "T1"]) == [
        "League of Legends", "T1"
    ]


def test_canonical_drops_labels_the_vocabulary_does_not_have():
    assert _canonical(["MLB", "invented"], ["MLB"]) == ["MLB"]


def test_canonical_dedupes_while_keeping_order():
    assert _canonical(["MLB", "mlb", "NBA"], ["MLB", "NBA"]) == ["MLB", "NBA"]


def test_normalize_keeps_one_off_labels_that_canonical_would_drop():
    """A video keeps a specific topic (the only New Zealand video) even though
    it's too rare to become a channel-wide chip."""
    display = {_key("travel"): "travel"}
    assert _normalize(["Travel", "New Zealand"], display) == ["travel", "New Zealand"]


def test_dedupe_is_order_preserving_and_key_based():
    assert _dedupe(["MLB", "mlb", "NBA", "M L B"]) == ["MLB", "NBA"]


def test_max_labels_is_the_cap_the_prompt_asks_for():
    """A prompt and a truncation that disagree lose labels silently — filtering
    is a server-side query on the stored labels, so a dropped one removes the
    video from that chip's results."""
    assert MAX_LABELS == 6
    assert len(_dedupe([f"label{i}" for i in range(20)])[:MAX_LABELS]) == 6


# ── Stored state ─────────────────────────────────────────────────────


def test_is_current_only_when_built_at_this_version():
    assert is_current(Channel(youtube_id="c", title="x", video_label_vocab="[]",
                              video_label_version=LABEL_VERSION)) is True
    # Never built.
    assert is_current(Channel(youtube_id="c", title="x", video_label_vocab=None,
                              video_label_version=LABEL_VERSION)) is False
    # Built by an older prompt — re-labels on the next visit.
    assert is_current(Channel(youtube_id="c", title="x", video_label_vocab="[]",
                              video_label_version=LABEL_VERSION - 1)) is False
    assert is_current(Channel(youtube_id="c", title="x", video_label_vocab="[]",
                              video_label_version=None)) is False


@pytest.mark.parametrize(
    "raw,expected",
    [
        ('["MLB"]', ["MLB"]),
        ("[]", []),
        ("not json", []),
        ('{"not": "a list"}', []),
        ("null", []),
    ],
)
def test_labels_or_empty_never_raises(raw, expected):
    assert _labels_or_empty(raw) == expected
