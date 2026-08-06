/**
 * The optional companion extension (see `extension/` at the repo root).
 *
 * The app works the same with or without it — everything here answers one
 * question, and both answers are supported paths that ship.
 */

// Set by the extension's content script at document_start, so it's already
// present by the time any of this runs. See extension/marker.js.
const MARKER = 'ytfeedEmbedClean'

let cached: boolean | null = null

/**
 * Whether YouTube's own overlays are being stripped from embedded players.
 *
 * Read ONCE and cached for the life of the page, deliberately. `controls` is a
 * playerVar baked into the iframe URL when the player is constructed, so an
 * answer that changed mid-session would leave already-built players disagreeing
 * with the bar drawn over them. Installing or removing the extension takes
 * effect on the next reload, which is when its stylesheet takes effect anyway.
 */
export function hasCleanEmbed(): boolean {
  if (cached === null) cached = document.documentElement.dataset[MARKER] === '1'
  return cached
}

/** Test seam: drops the cache so a case can set the marker and re-ask. */
export function resetCleanEmbedCache() {
  cached = null
}
