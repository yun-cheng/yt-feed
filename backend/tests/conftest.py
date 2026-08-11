"""Test harness for the backend.

Two things have to happen before anything under `app` is imported, which is why
they sit at module level rather than in a fixture:

  1. `app.database` builds its engine at import time from `settings.db_path`, so
     the path has to be redirected first or the suite runs against the real feed.
  2. `app.config` reads config_dir at import time too, and `categorizer` WRITES
     categories.yaml into it on first read — pointing it at a temp dir keeps the
     user's taxonomy file out of the tests' way.

pytest imports conftest before any test module, so this runs first.
"""

import os
import tempfile
from pathlib import Path

_TMP = Path(tempfile.mkdtemp(prefix="yt-feed-tests-"))
os.environ["DB_PATH"] = str(_TMP / "test.db")
os.environ["CONFIG_DIR"] = str(_TMP / "config")
# Never let a test reach the network. `llm.chat_json` raises without a key, and
# every caller of it is written to degrade rather than fail — so an accidentally
# un-stubbed call surfaces as a degraded result, not a live request.
os.environ["OPENROUTER_API_KEY"] = ""

import pytest  # noqa: E402
import pytest_asyncio  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402

from app.database import Base, engine  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(scope="session")
def tmp_root() -> Path:
    """The temp dir holding the test DB and config — handy for path assertions."""
    return _TMP


@pytest_asyncio.fixture(autouse=True)
async def fresh_db():
    """A schema with no rows in it, per test.

    Dropping and recreating rather than rolling back a transaction: the routers
    open their own sessions through `async_session` (they don't take an injected
    one), so there is no outer transaction for a test to own.
    """
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    yield


@pytest_asyncio.fixture(autouse=True)
async def seeded_user(request):
    """One account, as every real machine running this has.

    The app resolves the caller through `auth.user_or_sole`, which answers "the
    sole account" for an anonymous browser — so without a row here every endpoint
    that owns per-user data would 401 and the suite would be testing the sign-in
    wall rather than the feature.

    Tests that are ABOUT accounts need the table empty to say anything, and mark
    themselves `no_seeded_user`.
    """
    if "no_seeded_user" in request.keywords:
        return None

    from app.database import async_session
    from app.users import ensure_local_user

    async with async_session() as session:
        user = await ensure_local_user(session)
        await session.commit()
        return user


@pytest_asyncio.fixture
async def client():
    """The real app over an in-process transport.

    ASGITransport deliberately does NOT run the lifespan, which is what keeps the
    scan scheduler, the resync loop and the Meilisearch reindex from starting up
    behind the tests. `fresh_db` builds the schema that lifespan would have.
    """
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c


@pytest_asyncio.fixture
async def db():
    """A session for tests that need to seed rows the API can't create."""
    from app.database import async_session

    async with async_session() as session:
        yield session
