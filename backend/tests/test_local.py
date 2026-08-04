"""Local folders — a directory on this machine browsed as its own feed.

The scan is real (it walks a temp directory), but the media tools are not:
ffprobe/ffmpeg are stubbed, so these tests don't depend on either being
installed and don't spend a subprocess per file.
"""

import os

import pytest

from app.routers.local import (
    END_TAIL_SEC,
    MIN_PROGRESS_SEC,
    VIDEO_EXTS,
    _abs_path,
    _video_id,
    _walk,
)


@pytest.fixture
def folder(tmp_path):
    """A directory with two videos, one of them in a subfolder, plus files the
    scan is supposed to ignore."""
    (tmp_path / "a.mp4").write_bytes(b"fake")
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "b.mkv").write_bytes(b"fake")
    (tmp_path / "notes.txt").write_text("not a video")
    (tmp_path / ".hidden.mp4").write_bytes(b"fake")
    (tmp_path / ".sync").mkdir()
    (tmp_path / ".sync" / "c.mp4").write_bytes(b"fake")
    return tmp_path


@pytest.fixture(autouse=True)
def no_media_tools(monkeypatch):
    """Never fork ffprobe/ffmpeg in tests. The probe pass runs in a background
    thread against its own event loop, so its results aren't asserted here —
    only that the scan itself doesn't depend on it."""
    monkeypatch.setattr("app.routers.local._probe_duration", lambda path: 0)
    monkeypatch.setattr("app.routers.local._make_thumb", lambda src, dst, dur: False)
    monkeypatch.setattr("app.routers.local._start_probe", lambda folder_id: None)


# ── The walk ─────────────────────────────────────────────────────────


def test_walk_finds_videos_at_any_depth(folder):
    assert [rel for rel, _st in _walk(str(folder))] == ["a.mp4", os.path.join("sub", "b.mkv")]


def test_walk_skips_non_videos_and_dotfiles(folder):
    found = {rel for rel, _st in _walk(str(folder))}
    assert not any("notes.txt" in f or "hidden" in f or ".sync" in f for f in found)


def test_walk_covers_the_extensions_the_module_claims(tmp_path):
    for i, ext in enumerate(sorted(VIDEO_EXTS)):
        (tmp_path / f"v{i}{ext}").write_bytes(b"fake")
    assert len(_walk(str(tmp_path))) == len(VIDEO_EXTS)


def test_walk_matches_extensions_case_insensitively(tmp_path):
    (tmp_path / "SHOUTING.MP4").write_bytes(b"fake")
    assert [rel for rel, _st in _walk(str(tmp_path))] == ["SHOUTING.MP4"]


def test_walk_of_a_missing_directory_is_empty_not_an_error(tmp_path):
    assert _walk(str(tmp_path / "gone")) == []


# ── Ids and path safety ──────────────────────────────────────────────


def test_video_id_is_stable_and_per_folder():
    assert _video_id(1, "a.mp4") == _video_id(1, "a.mp4")
    assert _video_id(1, "a.mp4") != _video_id(2, "a.mp4")
    assert _video_id(1, "a.mp4") != _video_id(1, "b.mp4")
    assert len(_video_id(1, "a.mp4")) == 16


def test_abs_path_refuses_to_escape_its_folder(folder):
    from fastapi import HTTPException

    from app.models import LocalFolder

    f = LocalFolder(id=1, path=str(folder))
    assert _abs_path(f, "a.mp4") == os.path.realpath(str(folder / "a.mp4"))
    with pytest.raises(HTTPException) as e:
        _abs_path(f, "../../etc/passwd")
    assert e.value.status_code == 400


def test_abs_path_refuses_a_sibling_with_a_shared_prefix(tmp_path):
    """`/videos-private` must not pass the check for `/videos`."""
    from fastapi import HTTPException

    from app.models import LocalFolder

    (tmp_path / "videos").mkdir()
    (tmp_path / "videos-private").mkdir()
    f = LocalFolder(id=1, path=str(tmp_path / "videos"))
    with pytest.raises(HTTPException):
        _abs_path(f, "../videos-private/secret.mp4")


# ── The endpoints ────────────────────────────────────────────────────


async def add_folder(client, path, name=""):
    r = await client.post("/api/local/folders", json={"path": str(path), "name": name})
    assert r.status_code == 200, r.text
    return r.json()


async def test_add_folder_scans_it(client, folder):
    out = await add_folder(client, folder, name="Clips")
    assert out["folder"]["name"] == "Clips"
    assert out["folder"]["video_count"] == 2
    assert [v["title"] for v in out["videos"]] == ["a", "b"]


async def test_video_serialization_carries_what_the_card_needs(client, folder):
    out = await add_folder(client, folder)
    sub = next(v for v in out["videos"] if v["title"] == "b")
    assert sub["sub_dir"] == "sub"  # the folder page groups on this
    assert sub["rel_path"] == os.path.join("sub", "b.mkv")
    assert sub["file_url"] == f"/api/local/videos/{sub['id']}/file"
    assert sub["thumbnail_url"] == f"/api/local/videos/{sub['id']}/thumb"
    assert sub["probed"] is False  # not measured yet — NOT "zero seconds long"
    assert sub["filesize"] == 4
    assert sub["modified_at"]


async def test_a_top_level_video_has_no_sub_dir(client, folder):
    out = await add_folder(client, folder)
    top = next(v for v in out["videos"] if v["title"] == "a")
    assert top["sub_dir"] == ""


async def test_folder_name_defaults_to_the_directory_name(client, folder):
    out = await add_folder(client, folder)
    assert out["folder"]["name"] == folder.name


async def test_re_adding_a_folder_rescans_rather_than_duplicating(client, folder):
    first = await add_folder(client, folder)
    (folder / "c.mp4").write_bytes(b"fake")
    second = await add_folder(client, folder)
    assert first["folder"]["id"] == second["folder"]["id"]
    assert len((await client.get("/api/local/folders")).json()) == 1
    assert len(second["videos"]) == 3


async def test_a_deleted_file_drops_out_on_rescan(client, folder):
    await add_folder(client, folder)
    (folder / "a.mp4").unlink()
    out = (await client.get("/api/local/folders/1/videos")).json()
    assert [v["title"] for v in out["videos"]] == ["b"]


async def test_rescan_false_reads_the_cache_only(client, folder):
    """The page polls with this while durations are being measured; it must not
    re-walk the directory each time."""
    await add_folder(client, folder)
    (folder / "a.mp4").unlink()
    out = (await client.get("/api/local/folders/1/videos?rescan=false")).json()
    assert [v["title"] for v in out["videos"]] == ["a", "b"]


async def test_add_folder_rejects_a_path_that_is_not_a_directory(client, tmp_path):
    (tmp_path / "file.txt").write_text("x")
    assert (await client.post("/api/local/folders", json={"path": str(tmp_path / "file.txt")})).status_code == 400
    assert (await client.post("/api/local/folders", json={"path": str(tmp_path / "nope")})).status_code == 400
    assert (await client.post("/api/local/folders", json={"path": "  "})).status_code == 400


async def test_folder_reports_unavailable_when_its_drive_goes_away(client, tmp_path):
    """An unmounted drive keeps its rows — the page says so instead of showing
    an empty folder as though you'd added an empty one."""
    (tmp_path / "gone").mkdir()
    (tmp_path / "gone" / "a.mp4").write_bytes(b"fake")
    await add_folder(client, tmp_path / "gone")
    assert (await client.get("/api/local/folders/1")).json()["available"] is True
    (tmp_path / "gone" / "a.mp4").unlink()
    (tmp_path / "gone").rmdir()
    row = (await client.get("/api/local/folders/1")).json()
    assert row["available"] is False
    assert (await client.get("/api/local/folders")).json()[0]["available"] is False


async def test_missing_folder_is_404(client):
    assert (await client.get("/api/local/folders/999")).status_code == 404
    assert (await client.get("/api/local/folders/999/videos")).status_code == 404


async def test_remove_folder_forgets_the_rows(client, folder):
    await add_folder(client, folder)
    assert (await client.delete("/api/local/folders/1")).status_code == 200
    assert (await client.get("/api/local/folders")).json() == []


async def test_remove_folder_never_touches_the_files(client, folder):
    await add_folder(client, folder)
    await client.delete("/api/local/folders/1")
    assert (folder / "a.mp4").exists()
    assert (folder / "sub" / "b.mkv").exists()


async def test_serving_a_local_file(client, folder):
    out = await add_folder(client, folder)
    vid = out["videos"][0]["id"]
    r = await client.get(f"/api/local/videos/{vid}/file")
    assert r.status_code == 200
    assert r.content == b"fake"


async def test_serving_a_file_that_has_since_gone(client, folder):
    out = await add_folder(client, folder)
    vid = out["videos"][0]["id"]
    (folder / "a.mp4").unlink()
    assert (await client.get(f"/api/local/videos/{vid}/file")).status_code == 404


async def test_unknown_video_is_404(client):
    assert (await client.get("/api/local/videos/nope")).status_code == 404
    assert (await client.get("/api/local/videos/nope/file")).status_code == 404
    assert (await client.post("/api/local/videos/nope/progress", json={"position_seconds": 10})).status_code == 404


# ── Resume ───────────────────────────────────────────────────────────


async def a_video(client, folder) -> str:
    return (await add_folder(client, folder))["videos"][0]["id"]


async def test_progress_below_the_threshold_is_a_click_not_a_watch(client, folder):
    vid = await a_video(client, folder)
    r = await client.post(
        f"/api/local/videos/{vid}/progress",
        json={"position_seconds": MIN_PROGRESS_SEC - 1, "duration_seconds": 600},
    )
    assert r.json()["position_seconds"] == 0.0


async def test_progress_is_remembered(client, folder):
    vid = await a_video(client, folder)
    await client.post(
        f"/api/local/videos/{vid}/progress",
        json={"position_seconds": 123.5, "duration_seconds": 600},
    )
    row = (await client.get(f"/api/local/videos/{vid}")).json()
    assert row["position_seconds"] == 123.5
    assert row["watched"] is False
    # The player's duration fills in what the (stubbed) probe couldn't measure.
    assert row["duration_seconds"] == 600


async def test_reaching_the_end_marks_it_watched(client, folder):
    vid = await a_video(client, folder)
    r = await client.post(
        f"/api/local/videos/{vid}/progress",
        json={"position_seconds": 600 - END_TAIL_SEC, "duration_seconds": 600},
    )
    assert r.json()["watched"] is True


async def test_watched_is_sticky_across_a_rewatch(client, folder):
    vid = await a_video(client, folder)
    await client.post(
        f"/api/local/videos/{vid}/progress", json={"position_seconds": 595, "duration_seconds": 600}
    )
    r = await client.post(
        f"/api/local/videos/{vid}/progress", json={"position_seconds": 30, "duration_seconds": 600}
    )
    assert r.json()["watched"] is True
    assert r.json()["position_seconds"] == 30


async def test_clearing_progress_resets_both_fields(client, folder):
    vid = await a_video(client, folder)
    await client.post(
        f"/api/local/videos/{vid}/progress", json={"position_seconds": 595, "duration_seconds": 600}
    )
    r = await client.delete(f"/api/local/videos/{vid}/progress")
    assert r.json()["position_seconds"] == 0.0
    assert r.json()["watched"] is False


async def test_progress_survives_a_rescan(client, folder):
    """A rescan reconciles rows against disk; an unchanged file must keep its
    resume point rather than being treated as a new one."""
    vid = await a_video(client, folder)
    await client.post(
        f"/api/local/videos/{vid}/progress", json={"position_seconds": 123.5, "duration_seconds": 600}
    )
    await client.get("/api/local/folders/1/videos")
    assert (await client.get(f"/api/local/videos/{vid}")).json()["position_seconds"] == 123.5
