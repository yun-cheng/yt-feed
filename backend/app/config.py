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