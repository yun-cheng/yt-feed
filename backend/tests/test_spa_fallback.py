"""Serving the built frontend from this process, without swallowing the API.

The catch-all that makes client-side routes reloadable matches *everything*, so
the tests worth having are about what it must NOT match. Two of them:

  * a path under `/api` that no endpoint serves is still a 404. Answered with
    `index.html` instead, a frontend calling a route the backend doesn't have
    would fail as a JSON parse error in whatever read the response — a long way
    from the mistake. `test_api_contract.py` exists to catch exactly that class
    of drift, and a catch-all is the one thing that could quietly disarm it.
  * `..` in the path doesn't reach outside the build directory.

`SPA_DIR` is monkeypatched rather than built, because `npm run build` in a test
would be slow, would need node, and wouldn't pin anything these two don't.
"""

from pathlib import Path

import pytest

from app import main


@pytest.fixture
def built(tmp_path, monkeypatch):
    """A `dist` directory, as a production image has baked in."""
    (tmp_path / "index.html").write_text("<!doctype html><title>YT Feed</title>")
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "app.js").write_text("console.log('app')")
    monkeypatch.setattr(main, "SPA_DIR", tmp_path)
    return tmp_path


async def test_a_client_side_route_is_answered_with_the_app(client, built):
    """`/watch/abc` was never built as a file — a reload on it has to get the
    app, or every deep link in the app 404s on refresh."""
    r = await client.get("/watch/abc")

    assert r.status_code == 200
    assert "YT Feed" in r.text


async def test_a_built_asset_is_served_as_itself(client, built):
    r = await client.get("/assets/app.js")

    assert r.status_code == 200
    assert "console.log" in r.text


async def test_an_unknown_api_path_is_still_a_404(client, built):
    """The one that matters. `index.html` here would mean a frontend calling a
    path this backend doesn't serve gets HTML and a 200, and the test that
    compares the two sides would have nothing left to find."""
    r = await client.get("/api/no-such-endpoint")

    assert r.status_code == 404
    assert "YT Feed" not in r.text


def test_a_traversing_path_resolves_to_nothing(built, tmp_path):
    """`..` is just characters until something joins it to a directory.

    Against `_spa_file` rather than through the client, and that is the finding
    rather than a shortcut: a request for `/../outside.txt` never arrives as one.
    Both httpx and Starlette normalise the path away, so a test that went over
    HTTP passed with the containment check deleted — it was asserting that URL
    normalisation works, which is nobody's bug here. The check is in `_spa_file`,
    so that is where it has to be pinned.
    """
    outside = tmp_path.parent / "outside.txt"
    outside.write_text("not for serving")

    assert main._spa_file("../outside.txt") is None
    assert main._spa_file("assets/../../outside.txt") is None
    # And it still finds what it is supposed to find.
    assert main._spa_file("assets/app.js") == (built / "assets" / "app.js").resolve()


async def test_without_a_build_there_is_nothing_to_serve(client, tmp_path, monkeypatch):
    """Development: Vite serves the app and this process serves only `/api`, so a
    stray URL here is a 404 exactly as it was before any of this existed."""
    monkeypatch.setattr(main, "SPA_DIR", tmp_path / "never-built")

    assert (await client.get("/watch/abc")).status_code == 404


def test_the_catch_all_stays_out_of_the_schema():
    """`app.openapi()` is the route table `test_api_contract.py` checks the
    frontend's calls against. A path pattern that matches everything would make
    every one of those checks pass on its own."""
    universal = [
        p for p in main.app.openapi()["paths"]
        if p in ("/{full_path}", "/{full_path:path}")
    ]

    assert universal == [], f"a catch-all reached the schema: {universal}"
