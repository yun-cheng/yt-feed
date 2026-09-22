from pydantic import model_validator
from pydantic_settings import BaseSettings
from pathlib import Path


class Settings(BaseSettings):
    # --- Paths ---
    project_root: str = str(Path(__file__).resolve().parent.parent.parent)

    # Everything this app writes, under one directory — the database, the
    # downloads, the OAuth token, the generated session key. One directory
    # because a container needs exactly one mounted volume to survive a rebuild,
    # and because "what do I back up" should have a one-line answer.
    #
    # `DATA_DIR` moves the whole lot. `DB_PATH` and `CONFIG_DIR` still override
    # individually (the test harness sets both), which is why those two are
    # filled in below rather than defaulted here: a default computed in the class
    # body would be frozen against the DEFAULT data_dir and would ignore the env.
    data_dir: str = str(Path(project_root) / "data")
    db_path: str = ""
    config_dir: str = ""

    # --- OAuth (optional, only for initial subscription import) ---
    # A bootstrap default only. The live values are stored in the database and
    # set from Settings → Connections — see app/runtime_config.py, which reads
    # these when nothing has been stored.
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

    # --- YouTube extraction (yt-dlp) ---
    # Route yt-dlp's requests through a proxy, for a host whose address YouTube
    # refuses. Bootstrap default; normally set from Settings → Connections. Kept
    # as env too because it is the one value you may want in place BEFORE first
    # boot: the first scan starts 30 seconds in, and on a blocked address that is
    # a scan that fetches nothing.
    youtube_proxy: str = ""

    # --- Search (Meilisearch companion service) ---
    meili_url: str = "http://127.0.0.1:7700"
    # Bootstrap default; the live value lives in the database. Empty = dev mode
    # (no auth), which is fine for a Meilisearch only this machine can reach.
    meili_master_key: str = ""

    # --- LLM (OpenRouter — shared by AI features like channel tagging) ---
    # Bootstrap default. Normally set from Settings → Connections instead; see
    # app/runtime_config.py for which wins.
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

    # --- Local speech-to-text (see app/asr.py) ---
    # For the videos YouTube has no caption track for at all. Optional and NOT
    # in requirements.txt: mlx-whisper is Apple-Silicon only, so the feature
    # advertises itself through asr.available() and simply isn't offered
    # elsewhere. `pip install mlx-whisper opencc-python-reimplemented` turns it
    # on — see the note at the foot of requirements.txt.
    #
    # large-v3-turbo rather than large-v3: measured on an M4 it holds ~8.6x
    # realtime with word timestamps on, which is the whole reason the transcript
    # can stay ahead of playback, and its Mandarin was clean enough to read
    # as-is. The key is part of the stored track's identity, so pointing this at
    # a bigger model adds a track beside the old rather than reinterpreting it.
    asr_model: str = "mlx-community/whisper-large-v3-turbo"

    # --- Archive fill (deep per-channel history; see app/archive.py) ---
    # Off by default: switching it on commits the API quota and the disk for
    # every channel's whole back catalogue, which should be a thing you chose
    # rather than something a deploy started. The per-channel "fetch the rest"
    # action works either way — this flag only governs the unattended sweep.
    archive_fill_enabled: bool = False

    model_config = {"env_file": ".env", "extra": "ignore"}

    @model_validator(mode="after")
    def _derive_paths(self):
        """Fill the paths that follow `data_dir`, unless they were set outright.

        After validation rather than as class-body defaults, because a default is
        evaluated once when the class is built — against the DEFAULT `data_dir` —
        so `DATA_DIR=/data` would move the directory and leave the database
        behind in it. Here both env vars work, and `DB_PATH` / `CONFIG_DIR` keep
        winning individually, which is what the test harness relies on.
        """
        if not self.db_path:
            self.db_path = str(Path(self.data_dir) / "youtube_feed.db")
        if not self.config_dir:
            self.config_dir = str(Path(self.data_dir) / "config")
        return self

    @property
    def cookies_path(self) -> str:
        """The yt-dlp cookie jar, written from the stored setting.

        yt-dlp takes a path, not a string, so the value pasted into Settings has
        to land on disk somewhere. Under `config_dir` with the OAuth token, which
        is the other credential this app keeps as a file.
        """
        return str(Path(self.config_dir) / "youtube_cookies.txt")

    @property
    def downloads_dir(self) -> str:
        # These three follow the DATABASE rather than `data_dir`. The same
        # directory in every real deployment, and deliberately so where it isn't:
        # `DB_PATH` alone is enough to move a whole feed somewhere else, media
        # included, which is what makes it a usable escape hatch rather than one
        # setting out of four.
        return str(Path(self.db_path).parent / "downloads")

    @property
    def asr_audio_dir(self) -> str:
        """Scratch space for audio a transcription job is working through.

        A cache only: each file is deleted when its job finishes, and a job that
        died mid-way re-fetches in about a second. What survives is the cues.
        """
        return str(Path(self.db_path).parent / "asr-audio")

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