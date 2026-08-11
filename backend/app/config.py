from pydantic_settings import BaseSettings
from pathlib import Path


class Settings(BaseSettings):
    # --- Paths ---
    project_root: str = str(Path(__file__).resolve().parent.parent.parent)
    db_path: str = str(Path(project_root) / "data" / "youtube_feed.db")
    config_dir: str = str(Path(project_root) / "backend" / "config")

    # --- OAuth (optional, only for initial subscription import) ---
    google_client_id: str = ""
    google_client_secret: str = ""

    # --- Session ---
    # Signs the sign-in cookie. Changing it signs everybody out, which is also
    # the only revocation this app has — deliberately, at this scale.
    secret_key: str = "change-me-in-production"

    # Who may sign in, as a comma-separated list of Google account emails.
    # Empty (the default) means anyone who can reach the server — which on a
    # LAN-only bind is the household. Set it only if the app is reachable more
    # widely than you'd like. See `may_sign_in` in auth.py.
    allowed_emails: str = ""

    # Where the browser should land after signing in, and the origin the app is
    # served from. Also what CORS allows.
    app_origin: str = "http://localhost:5173"

    # --- Search (Meilisearch companion service) ---
    meili_url: str = "http://127.0.0.1:7700"
    meili_master_key: str = ""  # empty = dev mode (no auth), fine for localhost

    # --- LLM (OpenRouter — shared by AI features like channel tagging) ---
    openrouter_api_key: str = ""
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    # Channel/video tagging runs in the background, so latency doesn't matter.
    llm_tagging_model: str = "deepseek/deepseek-v4-flash"
    # Subtitle translation (watch page "AI translate") is read while the video
    # plays, so it's picked for speed instead: measured over 4 runs of the same
    # 10-line batch, gemini-2.5-flash-lite held a 1.6s median against 5.0s for
    # deepseek-v4-flash at the same ~$0.0001 per batch. Gemini mangled batches
    # when it was first tried, but that was our input (cue fragments, not whole
    # sentences) — see _to_sentences — and it went 10/10 once that was fixed.
    llm_translate_model: str = "google/gemini-2.5-flash-lite"

    # --- Archive fill (deep per-channel history; see app/archive.py) ---
    # Off by default: switching it on commits the API quota and the disk for
    # every channel's whole back catalogue, which should be a thing you chose
    # rather than something a deploy started. The per-channel "fetch the rest"
    # action works either way — this flag only governs the unattended sweep.
    archive_fill_enabled: bool = False

    model_config = {"env_file": ".env", "extra": "ignore"}

    @property
    def downloads_dir(self) -> str:
        return str(Path(self.db_path).parent / "downloads")

    @property
    def local_thumbs_dir(self) -> str:
        """Poster frames extracted from local-folder videos (see routers/local.py)."""
        return str(Path(self.db_path).parent / "local_thumbs")

    @property
    def categories_path(self) -> str:
        return str(Path(self.config_dir) / "categories.yaml")

    @property
    def subscriptions_path(self) -> str:
        return str(Path(self.config_dir) / "subscriptions.yaml")


settings = Settings()