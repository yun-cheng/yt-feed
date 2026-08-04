"""The legacy keyword categorizer, which reads and writes config/categories.yaml.

conftest points config_dir at a temp directory, so these exercise the real file
round-trip without touching the user's taxonomy.
"""

import pytest
import yaml

from app import categorizer
from app.config import settings


@pytest.fixture(autouse=True)
def clean_config(tmp_path, monkeypatch):
    """Each test gets its own categories.yaml — the module has no state of its
    own, it re-reads the file on every call."""
    monkeypatch.setattr(settings, "config_dir", str(tmp_path))
    yield


def test_first_read_writes_the_defaults():
    """The file is created on demand, so a fresh checkout has a taxonomy."""
    cats = categorizer.get_categories()
    assert [c["name"] for c in cats] == [c["name"] for c in categorizer.DEFAULT_CATEGORIES["categories"]]
    assert (yaml.safe_load(open(settings.categories_path))) is not None


def test_categories_carry_an_icon_and_a_sort_order():
    for c in categorizer.get_categories():
        assert c["icon"]
        assert isinstance(c["sort_order"], int)
        assert c["keywords"]


def test_auto_categorize_matches_on_title_and_description():
    result = categorizer.auto_categorize([
        {"youtube_id": "c1", "title": "Coding Daily", "description": "software and programming"},
        {"youtube_id": "c2", "title": "Piano Covers", "description": "music every week"},
    ])
    assert "c1" in result["科技"]
    assert "c2" in result["音樂"]


def test_matching_is_case_insensitive():
    result = categorizer.auto_categorize([
        {"youtube_id": "c1", "title": "PROGRAMMING WEEKLY", "description": ""},
    ])
    assert "c1" in result["科技"]


def test_chinese_keywords_match_too():
    result = categorizer.auto_categorize([
        {"youtube_id": "c1", "title": "程式設計教學", "description": "軟體開發"},
    ])
    assert "c1" in result["科技"]


def test_the_best_scoring_category_wins():
    """One incidental keyword shouldn't beat several on-topic ones."""
    result = categorizer.auto_categorize([
        {"youtube_id": "c1", "title": "Guitar and piano music",
         "description": "song covers, plus the occasional gaming stream"},
    ])
    assert "c1" in result["音樂"]
    assert "c1" not in result.get("遊戲", [])


def test_a_channel_matching_nothing_is_left_uncategorized():
    assert categorizer.auto_categorize([
        {"youtube_id": "c1", "title": "zzzz", "description": ""},
    ]) == {}


def test_auto_assignment_is_recorded_with_an_auto_prefix():
    categorizer.auto_categorize([{"youtube_id": "c1", "title": "Coding Daily", "description": ""}])
    assert categorizer.get_channel_groups()["c1"] == "auto:科技"


def test_a_manual_assignment_is_never_overwritten_by_the_auto_pass():
    categorizer.set_channel_group("c1", "音樂", auto=False)
    categorizer.auto_categorize([{"youtube_id": "c1", "title": "Coding Daily", "description": ""}])
    assert categorizer.get_channel_groups()["c1"] == "音樂"


def test_an_earlier_auto_assignment_is_replaced():
    categorizer.set_channel_group("c1", "遊戲", auto=True)
    categorizer.auto_categorize([{"youtube_id": "c1", "title": "Coding Daily", "description": ""}])
    assert categorizer.get_channel_groups()["c1"] == "auto:科技"


def test_remove_channels_drops_stale_keys():
    """Called when pruning unsubscribed channels, so the file doesn't keep
    growing keys for channels that are gone."""
    categorizer.set_channel_group("c1", "音樂")
    categorizer.set_channel_group("c2", "遊戲")
    assert categorizer.remove_channels(["c1", "never-existed"]) == 1
    assert set(categorizer.get_channel_groups()) == {"c2"}


def test_removing_nothing_is_a_no_op():
    assert categorizer.remove_channels([]) == 0


def test_add_category_appends_and_is_idempotent():
    before = len(categorizer.get_categories())
    categorizer.add_category("測試", "🧪", ["testing"])
    assert len(categorizer.get_categories()) == before + 1
    categorizer.add_category("測試", "🧪", ["other"])
    assert len(categorizer.get_categories()) == before + 1


def test_a_new_category_is_matched_by_the_auto_pass():
    categorizer.add_category("Woodworking", "🪵", ["woodworking", "joinery"])
    result = categorizer.auto_categorize([
        {"youtube_id": "c1", "title": "Hand-cut joinery", "description": ""},
    ])
    assert "c1" in result["Woodworking"]
