"""Test harness for the backend.

Three things have to happen before anything under `app` is imported, which is why
they sit at module level rather than in a fixture:

  1. `app.database` builds its engine at import time from `settings.db_path`, so
     the path has to be redirected first or the suite runs against the real feed.
  2. `app.config` reads config_dir at import time too, and `categorizer` WRITES
     categories.yaml into it on first read — pointing it at a temp dir keeps the
     user's taxonomy file out of the tests' way.
  3. `app.bootstrap.prepare()` runs when `app.main` is imported and CREATES
     directories and files under `data_dir` — the generated session key, the
     setup token, the media directories. Redirecting `DATA_DIR` is what keeps a
     test run from writing into the real one.

All three, not just `DATA_DIR`, because the first two are individual overrides
and one of them needs to keep working: `CONFIG_DIR` pointed away from `data_dir`
is also the signal `bootstrap` reads as "this config directory was chosen", which
is what stops a test run adopting the real feed's OAuth token.

pytest imports conftest before any test module, so this runs first.
"""

import os
import tempfile
from pathlib import Path

_TMP = Path(tempfile.mkdtemp(prefix="yt-feed-tests-"))
os.environ["DATA_DIR"] = str(_TMP)
os.environ["DB_PATH"] = str(_TMP / "test.db")
os.environ["CONFIG_DIR"] = str(_TMP / "config")
# Never inherit the real deployment's config. `bootstrap.prepare()` runs when
# `app.main` is imported and otherwise copies `backend/config/` forward — which
# includes a live OAuth token, so a test run would hold real credentials and make
# real YouTube API calls with them. It did, before this line existed.
os.environ["SKIP_CONFIG_ADOPTION"] = "1"
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
    from app import runtime_config

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    # `runtime_config` caches the app_settings table because its callers are sync
    # and can't await a query; it invalidates itself when the app writes a
    # setting, but dropping the table underneath it isn't a write it can see. So
    # a key stored by one test would still answer for the next.
    runtime_config.invalidate()
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
