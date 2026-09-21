"""Every `/api/…` the frontend calls is a route this app actually serves.

The two suites meet nowhere. The frontend's tests stub `fetch`, so they answer
whatever URL they are given; the backend's drive routes by name, so they never
see a call site. Rename a route, or drop the trailing slash off one, and both
suites stay green while the feature is dead in the browser — the failure only
shows up as a toast, on the page you forgot to open.

This reads the call sites out of the frontend source and resolves each against
the real route table. It can't check methods or shapes — a literal in a source
file doesn't say which verb it's used with — so it checks the one thing that is
unambiguous, and the one that breaks under renaming.

When this fails, either the route moved (fix the frontend) or the call site is
new and the route is missing (fix the backend). If it fails for a path that is
built too dynamically to read, add it to `UNREADABLE` with the reason.
"""

import re
from pathlib import Path

import pytest

from app.main import app

FRONTEND = Path(__file__).resolve().parents[2] / "frontend" / "src"

# Call sites assembled at runtime from pieces this scan can't see. Each one
# needs a reason; "the regex didn't like it" is a reason to fix the regex.
UNREADABLE: set[str] = set()


def _strip_interpolations(path: str) -> str:
    """`${...}` becomes one path segment, with braces balanced.

    Nested braces and nested template literals both turn up in these
    (`${a ? `x` : ''}`), so this counts rather than matching lazily.
    """
    out: list[str] = []
    i = 0
    while i < len(path):
        if path.startswith("${", i):
            depth, j = 1, i + 2
            while j < len(path) and depth:
                if path[j] == "{":
                    depth += 1
                elif path[j] == "}":
                    depth -= 1
                j += 1
            out.append("X")
            i = j
        else:
            out.append(path[i])
            i += 1
    return "".join(out)


def _call_sites() -> dict[str, set[str]]:
    """Every `/api/…` string literal in the frontend, to the files using it."""
    found: dict[str, set[str]] = {}
    for src_file in sorted(FRONTEND.rglob("*.ts*")):
        if "test" in src_file.parts:
            continue
        for line in src_file.read_text().splitlines():
            # Doc comments quote these paths when explaining them; a mention
            # isn't a call, and `/api/feed/storyboard` reads as a broken one.
            if line.lstrip().startswith(("*", "//", "/*")):
                continue
            for _, raw in re.findall(r"""(['"`])(/api/(?:[^'"`\\]|\\.)*)\1""", line):
                path = _strip_interpolations(raw).split("?")[0].rstrip("/")
                found.setdefault(path, set()).add(src_file.name)
    return found


def _route_patterns() -> list[tuple[str, re.Pattern]]:
    """The served routes, each as a regex with its path params opened up."""
    out = []
    for route in app.openapi()["paths"]:
        pattern = "^" + re.sub(r"\{[^}]+\}", "[^/]+", re.escape(route).replace(r"\{", "{").replace(r"\}", "}")) + "$"
        out.append((route, re.compile(pattern)))
    return out


CALLS = _call_sites()
ROUTES = _route_patterns()


def test_the_scan_found_the_call_sites_at_all():
    """A regex that quietly matches nothing would make every test below pass —
    by generating none of them."""
    assert len(CALLS) > 50, (
        f"only {len(CALLS)} call sites found under {FRONTEND}; the scan is "
        "broken or the frontend isn't there, and either way the checks below "
        "are vacuous"
    )


@pytest.mark.parametrize("path", sorted(CALLS))
def test_the_frontend_calls_a_route_that_exists(path):
    if path in UNREADABLE:
        pytest.skip("assembled at runtime; see UNREADABLE")
    # A path ending in a slash has its id appended at the call site.
    candidates = [path, f"{path}/X"]
    matched = any(pat.match(c) for c in candidates for _, pat in ROUTES)
    assert matched, (
        f"{path} is called from {sorted(CALLS[path])} but no route serves it"
    )
