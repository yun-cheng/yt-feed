"""Notes on a video: labels, fields with many values, and free text."""


async def put(client, video_id="vid1", **body):
    r = await client.put(f"/api/notes/video/{video_id}", json=body)
    assert r.status_code == 200, r.text
    return r.json()


async def test_a_video_with_nothing_written_has_an_empty_note(client):
    got = (await client.get("/api/notes/video/vid1")).json()
    assert got == {"labels": [], "fields": [], "note": "", "updated_at": None}


async def test_saved_whole_and_read_back(client):
    await put(
        client,
        labels=["comedy", "rewatch"],
        fields=[{"name": "Actors", "values": ["Ann", "Bo"]}, {"name": "Director", "values": ["Cy"]}],
        note="The scene at 12:00.\nWorth showing Dee.",
    )
    got = (await client.get("/api/notes/video/vid1")).json()
    assert got["labels"] == ["comedy", "rewatch"]
    assert got["fields"] == [
        {"name": "Actors", "values": ["Ann", "Bo"]},
        {"name": "Director", "values": ["Cy"]},
    ]
    assert got["note"] == "The scene at 12:00.\nWorth showing Dee."
    assert got["updated_at"]


async def test_each_video_keeps_its_own(client):
    await put(client, "vid1", labels=["a"])
    await put(client, "vid2", labels=["b"])
    assert (await client.get("/api/notes/video/vid1")).json()["labels"] == ["a"]
    assert (await client.get("/api/notes/video/vid2")).json()["labels"] == ["b"]


async def test_a_save_replaces_rather_than_adds(client):
    await put(client, labels=["a", "b"], note="first")
    await put(client, labels=["b"], note="second")
    got = (await client.get("/api/notes/video/vid1")).json()
    assert got["labels"] == ["b"]
    assert got["note"] == "second"


async def test_tidied_trimmed_blanks_dropped_duplicates_folded(client):
    got = await put(
        client,
        labels=["  Comedy ", "comedy", "", "two  words"],
        fields=[
            {"name": " Actors ", "values": ["Ann", " ann", "", "Bo"]},
            {"name": "actors", "values": ["Cy"]},
            {"name": "  ", "values": ["lost"]},
        ],
    )
    assert got["labels"] == ["Comedy", "two words"]
    assert got["fields"] == [{"name": "Actors", "values": ["Ann", "Bo", "Cy"]}]


async def test_a_field_made_but_not_yet_filled_is_kept(client):
    got = await put(client, fields=[{"name": "Actors", "values": []}])
    assert got["fields"] == [{"name": "Actors", "values": []}]


async def test_emptied_of_everything_it_is_gone(client):
    await put(client, labels=["a"], note="x")
    got = await put(client, labels=[], fields=[], note="   ")
    assert got == {"labels": [], "fields": [], "note": "", "updated_at": None}
    assert (await client.get("/api/notes/suggestions")).json() == {"labels": [], "fields": {}}


async def test_suggestions_offer_what_was_used_most_first(client):
    await put(client, "v1", labels=["rewatch", "comedy"], fields=[{"name": "Actors", "values": ["Ann", "Bo"]}])
    await put(client, "v2", labels=["comedy"], fields=[{"name": "actors", "values": ["Bo"]}])
    await put(client, "v3", labels=["Comedy"], fields=[{"name": "Actors", "values": []}, {"name": "Place", "values": ["Oslo"]}])
    got = (await client.get("/api/notes/suggestions")).json()
    # "comedy" three times, under the spelling used most.
    assert got["labels"] == ["comedy", "rewatch"]
    assert list(got["fields"]) == ["Actors", "Place"]
    assert got["fields"]["Actors"] == ["Bo", "Ann"]
    assert got["fields"]["Place"] == ["Oslo"]


async def test_non_latin_text_survives(client):
    got = await put(client, labels=["喜劇"], fields=[{"name": "演員", "values": ["周星馳"]}], note="好看")
    assert got["labels"] == ["喜劇"]
    assert got["fields"] == [{"name": "演員", "values": ["周星馳"]}]
