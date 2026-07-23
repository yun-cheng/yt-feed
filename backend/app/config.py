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
    secret_key: str = "change-me-in-production"

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

    model_config = {"env_file": ".env", "extra": "ignore"}

    @property
    def downloads_dir(self) -> str:
        return str(Path(self.db_path).parent / "downloads")

    @property
    def categories_path(self) -> str:
        return str(Path(self.config_dir) / "categories.yaml")

    @property
    def subscriptions_path(self) -> str:
        return str(Path(self.config_dir) / "subscriptions.yaml")


settings = Settings()