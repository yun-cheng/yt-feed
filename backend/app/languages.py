"""The languages the app speaks and the caption languages it offers.

Shared by the caption endpoints and the settings spec, so a default caption
language can only be one the watch page's switcher knows.
"""

# Caption languages we expose in the watch-page switcher, in menu order. A track
# whose code starts with one of these prefixes (e.g. "zh-Hant" → "zh") counts.
# YouTube's auto-translate makes most of these available on any captioned video.
# Labels are each language's own name, so they read the same in any app language.
CAPTION_LANG_OPTIONS = [
    ("en", "English"),
    ("zh", "中文"),
    ("ja", "日本語"),
    ("ko", "한국어"),
]

# The languages the app's own text comes in. "auto" follows the browser.
APP_LANG_OPTIONS = [
    ("auto", "Follow the browser"),
    ("en", "English"),
    ("zh-Hant", "繁體中文"),
]
