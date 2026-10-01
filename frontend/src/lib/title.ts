/**
 * The browser tab's title: what you're looking at, then the app's name, the way
 * YouTube does it ("Video title - YouTube"). A tab strip full of "My Feed"
 * can't tell one tab from another.
 *
 * Several things know a name at once. App knows the page ("History"). A
 * channel or playlist page knows which one, once it has loaded. The watch
 * overlay knows the video, and it opens over a page that stays mounted
 * underneath. So each one claims the title at a rank, and the highest rank
 * wins. Closing the overlay hands the title back to the page under it. A name
 * still loading (null or empty) claims nothing, so the rank below shows
 * meanwhile.
 */
import { useEffect } from 'react'
import { t } from './i18n'

/** Higher wins: a page's name, then which one of it, then a video over it. */
export const TITLE_RANK = { page: 0, item: 1, video: 2 } as const

type Claim = { rank: number; title: string }
const claims = new Set<Claim>()

function apply() {
  let top: Claim | null = null
  // A later claim at the same rank wins: it's the one that just arrived.
  for (const c of claims) if (!top || c.rank >= top.rank) top = c
  const app = t('My Feed')
  document.title = top ? `${top.title} - ${app}` : app
}

export function useDocumentTitle(title: string | null | undefined, rank: number) {
  useEffect(() => {
    const name = title?.trim()
    if (!name) return
    const claim = { rank, title: name }
    claims.add(claim)
    apply()
    return () => { claims.delete(claim); apply() }
  }, [title, rank])
}
