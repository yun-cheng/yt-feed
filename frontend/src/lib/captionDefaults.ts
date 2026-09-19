/**
 * The caption languages every video opens with — the `caption_lang` and
 * `caption_lang2` settings. '' means no particular language: the video's own
 * track for the first, no second track for the second. Installed at startup by
 * DefaultsLoader and again when Settings saves them; the watch page reads them
 * when a video opens, and a pick made on a video lasts for that video.
 */
export type CaptionDefaults = { lang: string; lang2: string }

let current: CaptionDefaults = { lang: '', lang2: '' }

const str = (v: unknown) => (typeof v === 'string' ? v : '')

export function setCaptionDefaults(values: { caption_lang?: unknown; caption_lang2?: unknown } | undefined) {
  current = { lang: str(values?.caption_lang), lang2: str(values?.caption_lang2) }
}

export function captionDefaults(): CaptionDefaults { return current }
