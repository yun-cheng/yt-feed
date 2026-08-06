/**
 * YouTube's playback-quality names, as resolutions people recognise.
 *
 * The embed reports quality as a label of its own ("hd1080", "large"), not a
 * height, and the older ones say nothing useful — "large" is 480p. This is the
 * translation.
 *
 * Only READING is possible from our side. `setPlaybackQuality` still exists on
 * the player but has been a no-op for years (called with "hd1080" the video
 * stays at 640x360, measured). The one setter that does work,
 * `setPlaybackQualityRange`, isn't proxied across the iframe boundary — it's
 * `undefined` on a parent-side player instance, reachable only from a script
 * running inside the embed. So the resolution is shown, not chosen.
 */

const LABELS: Record<string, string> = {
  tiny: '144p',
  small: '240p',
  medium: '360p',
  large: '480p',
  hd720: '720p',
  hd1080: '1080p',
  hd1440: '1440p',
  hd2160: '2160p',
  // Predates the hd* names and means "above 1080p" without saying how far, so
  // it's shown as-is rather than guessed at.
  highres: 'HD',
}

/**
 * A resolution for one of YouTube's quality names, or null if there's nothing
 * worth showing.
 *
 * Null covers three cases that all mean the same thing to a viewer: the player
 * hasn't decided yet ("unknown", which is what it reports until playback
 * starts), it's on automatic and hasn't settled ("auto"), or it's a name we
 * don't know. A label that says "auto" tells you nothing about what you're
 * actually watching.
 */
export function qualityLabel(quality: string | null | undefined): string | null {
  if (!quality) return null
  return LABELS[quality] ?? null
}

/** The same, for a file we play ourselves — where the height is simply known. */
export function heightLabel(height: number | null | undefined): string | null {
  return height && height > 0 ? `${height}p` : null
}
