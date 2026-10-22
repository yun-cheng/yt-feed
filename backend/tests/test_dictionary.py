"""Dictionary look-ups for a hovered caption word.

The real look-ups need a Mac, and assume only the two dictionaries every Mac
ships with ticked (the New Oxford American and its thesaurus), wherever
Dictionary.app puts them; the rest runs anywhere.
"""

import sys

import pytest

from app import dictionary

mac = pytest.mark.skipif(sys.platform != "darwin", reason="Dictionary Services is macOS-only")

LINE = "I love ice cream, so they're running home."
NOAD = "com.apple.dictionary.NOAD"


def noad(got: dict) -> str:
    """The New Oxford American's section, wherever Dictionary.app puts it."""
    return next(x["definition"] for x in got["sections"] if x["dictionary"] == NOAD)


@mac
async def test_a_hovered_letter_brings_back_its_whole_term(client):
    got = (await client.get("/api/dictionary", params={"text": LINE, "at": 12})).json()
    assert (got["term"], got["start"], got["length"]) == ("ice cream", 7, 9)
    assert "frozen" in noad(got)


@mac
async def test_an_inflected_word_finds_its_headword(client):
    got = (await client.get("/api/dictionary", params={"text": "she ran home", "at": 5})).json()
    assert got["term"] == "ran"
    assert noad(got).startswith("run")


@mac
def test_every_ticked_dictionary_with_the_word_gets_a_section():
    ticked = dictionary.ticked()
    got = [x.dictionary for x in dictionary.lookup("love", 0).sections]
    assert got == [k for k in ticked if k in got]  # in Dictionary.app's order
    assert len(got) > 1  # the dictionary and the thesaurus that ship on every Mac


@mac
@pytest.mark.parametrize("at", [16, 17, 41])  # the comma, a space, the full stop
async def test_between_words_is_no_entry(client, at):
    r = await client.get("/api/dictionary", params={"text": LINE, "at": at})
    assert r.status_code == 200
    assert r.json() is None


@mac
def test_positions_count_utf16_units_like_the_page():
    # The emoji is two units in JavaScript, one character in Python.
    e = dictionary.lookup("😀 love", 3)
    assert e and (e.term, e.start, e.length) == ("love", 3, 4)


def test_past_the_end_is_no_entry():
    assert dictionary.lookup("love", 4) is None


async def test_without_a_dictionary_the_route_says_so(client, monkeypatch):
    monkeypatch.setattr(dictionary, "available", lambda: False)
    r = await client.get("/api/dictionary", params={"text": "love", "at": 0})
    assert r.status_code == 503


@mac
def test_without_the_private_calls_the_default_still_answers(monkeypatch):
    monkeypatch.setattr(dictionary, "_can_list", False)
    e = dictionary.lookup("love", 0)
    assert e.term == "love" and [x.dictionary for x in e.sections] == [""]
