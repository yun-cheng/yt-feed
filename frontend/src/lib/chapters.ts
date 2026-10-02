/**
 * A video's chapters, as /api/feed/description serves them: yt-dlp's reading of
 * the timestamp list in the description, in seconds.
 *
 * The player shows them the way YouTube's does — the track cut into segments at
 * each chapter start, and the hovered chapter's title over the scrub preview.
 */

export type Chapter = { start: number; end: number; title: string }

/** The chapter playing at `t`, or null when there are none (or `t` is past them). */
export function chapterAt(chapters: readonly Chapter[] | undefined, t: number): Chapter | null {
  if (!chapters?.length) return null
  for (let i = chapters.length - 1; i >= 0; i--) {
    if (t >= chapters[i].start) return t < chapters[i].end || i === chapters.length - 1 ? chapters[i] : null
  }
  return null
}

/** How wide the cut between two chapters is, in px. */
export const CHAPTER_GAP = 2

/** A CSS mask that cuts the track at every chapter start after the first.
 *
 *  A mask rather than one div per segment, so the track and its fill stay single
 *  elements, and the play head, hover line and marks — drawn outside the masked
 *  layer — are never cut. Null when there's nothing to cut. */
export function chapterMask(chapters: readonly Chapter[] | undefined, duration: number): string | null {
  if (!chapters?.length || !(duration > 0)) return null
  const half = CHAPTER_GAP / 2
  const stops: string[] = []
  for (const c of chapters) {
    const pct = (c.start / duration) * 100
    if (pct <= 0 || pct >= 100) continue
    const at = pct.toFixed(3)
    stops.push(`#000 calc(${at}% - ${half}px)`, `transparent calc(${at}% - ${half}px)`,
      `transparent calc(${at}% + ${half}px)`, `#000 calc(${at}% + ${half}px)`)
  }
  if (!stops.length) return null
  return `linear-gradient(to right, #000 0, ${stops.join(', ')}, #000 100%)`
}
