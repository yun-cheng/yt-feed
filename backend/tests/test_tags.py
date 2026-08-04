"""The tag taxonomy and the deterministic parts of channel tagging.

`llm_label_channel` itself isn't exercised — it needs a key and its output is
non-deterministic. What surrounds it is: the derived taxonomy maps that the
sidebar renders from, and the language detection that runs without the LLM.
"""

import pytest

from app.routers.tags import (
    LANGUAGE_LABELS,
    MAIN_LABELS,
    SEED_TAXONOMY,
    TAG_GROUP,
    TAG_ICON,
    TAG_KIND,
    WATCH_STATUSES,
    _language_from_titles,
    _language_tag,
    tag_meta,
)


# ── The derived taxonomy ─────────────────────────────────────────────


def test_every_label_lands_in_exactly_one_group():
    """A label in two groups would show up twice in the sidebar and filter
    differently depending on which copy you clicked."""
    seen: dict[str, str] = {}
    for group, d in SEED_TAXONOMY.items():
        for label in list(d["main"]) + d["sub"]:
            assert label not in seen, f"{label} is in both {seen.get(label)} and {group}"
            seen[label] = group
    assert set(seen) == set(TAG_GROUP)


def test_every_label_has_a_group_icon_and_kind():
    for label in TAG_GROUP:
        group, icon, kind = tag_meta(label)
        assert group in SEED_TAXONOMY
        assert icon
        assert kind in ("main", "sub", "language")


def test_main_labels_are_the_ones_the_llm_may_apply():
    """Everything else it returns becomes a suggestion instead."""
    assert MAIN_LABELS == {l for l, k in TAG_KIND.items() if k in ("main", "language")}
    assert "coding" in MAIN_LABELS
    assert "python" not in MAIN_LABELS  # a sub label — suggested, never auto-applied


def test_language_labels_are_exactly_the_language_group():
    assert LANGUAGE_LABELS == set(SEED_TAXONOMY["Language"]["main"])


def test_sub_labels_inherit_their_groups_icon_until_promoted():
    assert TAG_ICON["python"] == SEED_TAXONOMY["Tech"]["icon"]


def test_an_invented_label_falls_back_to_other():
    """The LLM may invent sub labels; the sidebar still has to place them."""
    assert tag_meta("underwater-basket-weaving") == ("Other", "🏷️", "sub")


def test_watch_statuses_are_the_three_the_history_table_can_express():
    assert WATCH_STATUSES == ("unwatched", "in_progress", "watched")


# ── Language from what a channel publishes ───────────────────────────


def test_titles_beat_a_romanised_channel_name():
    """"GQ Taiwan" and "Taiwan Bar" read as English from the name alone, though
    every video is Chinese — which is the whole reason this reads the titles."""
    assert _language_from_titles(["台北美食推薦", "這家店超好吃", "台灣旅遊"]) == "chinese"


def test_kana_tells_japanese_apart_from_chinese():
    """Japanese shares Han characters with Chinese; kana is the discriminator."""
    assert _language_from_titles(["東京の朝ごはん", "カフェ巡り", "日本の電車すごい"]) == "japanese"


def test_english_titles():
    assert _language_from_titles(["How to build a shed", "My new camera"]) == "english"


def test_a_minority_of_cjk_titles_does_not_flip_the_channel():
    """The threshold is a majority, so an English channel with a couple of
    Chinese collabs stays English."""
    titles = ["English one", "English two", "English three", "中文影片"]
    assert _language_from_titles(titles) == "english"


def test_no_titles_means_no_answer():
    """A channel with nothing published falls through to the name instead."""
    assert _language_from_titles([]) is None


@pytest.mark.parametrize(
    "title,expected",
    [
        ("中文頻道", "chinese"),
        ("ドキュメンタリー", "japanese"),  # pure kana
        ("Some English Channel", "english"),
        ("AB", None),      # too short to be sure
        ("🎵🎶", None),      # emoji only
    ],
)
def test_language_from_the_channel_name(title, expected):
    assert _language_tag(title) == expected


def test_a_mixed_script_japanese_name_is_currently_read_as_chinese():
    """Pins a known wrong answer so a fix is a deliberate change, not a surprise.

    `_language_tag` tests for Han before kana, and ordinary Japanese mixes the
    two — so only a pure-kana name comes out japanese. `_language_from_titles`
    has the same two checks in the opposite order and gets these right, which is
    why this only bites a channel with no videos yet.
    """
    assert _language_tag("日本のチャンネル") == "chinese"
    assert _language_from_titles(["日本のチャンネル"]) == "japanese"


@pytest.mark.xfail(reason="kana is checked after Han in _language_tag", strict=True)
def test_a_mixed_script_japanese_name_should_be_japanese():
    assert _language_tag("日本のチャンネル") == "japanese"
