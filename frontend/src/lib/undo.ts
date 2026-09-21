/**
 * The removals you can take back.
 *
 * Every one of these was instant and final: a menu item, one click, the row
 * gone. The row is usually recoverable, though — so the pattern here is do it,
 * then offer to undo it, rather than pausing before doing it. A pause would
 * have to survive leaving the page, and it would make every deliberate deletion
 * feel slow to spare the rare accidental one.
 *
 * Undoing means putting the row back, not replaying the action that made it:
 * the server answers a delete with a RECEIPT of what it removed (`removed`),
 * and each restore below hands that receipt back. That's what keeps a restored
 * row identical — a history row's resume point and "Watched" badge, a playlist
 * item's place in the list — where re-reporting progress or re-adding the video
 * would quietly produce something slightly different.
 *
 * Each function takes an `after` the caller uses to put the row back on screen,
 * because every page here holds its list in React state and removed the row
 * optimistically.
 */
import { apiFetch } from './api'
import { pushUndo } from '../hooks/toastStore'
import { t } from './i18n'

/** What a delete hands back: the row, in the shape the page already renders. */
type Receipt = Record<string, unknown> | null

async function removeAndOffer(
  url: string,
  message: string,
  restore: (receipt: Receipt) => Promise<void>,
  after?: () => void,
): Promise<void> {
  let receipt: Receipt = null
  try {
    const res = await apiFetch(url, { method: 'DELETE' })
    if (!res.ok) return
    receipt = (await res.json())?.removed ?? null
  } catch {
    return   // apiFetch has already said so; there's nothing to offer back.
  }
  // Nothing was there to remove, so there is nothing to put back — and no
  // Undo button that would do anything if pressed.
  if (!receipt) return
  const held = receipt
  pushUndo(message, () => {
    restore(held).then(() => after?.()).catch(() => { /* apiFetch reported it */ })
  })
}

async function post(url: string, body: unknown): Promise<void> {
  await apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Forget a video, with its resume point and watched badge recoverable. */
export function removeHistory(videoId: string, after?: () => void): Promise<void> {
  return removeAndOffer(
    `/api/history/${videoId}`,
    t('Removed from history'),
    (receipt) => post('/api/history/restore', receipt),
    after,
  )
}

/** Take a video off a playlist, recoverable to the same position. */
export function removePlaylistItem(
  playlistId: number, videoId: string, after?: () => void,
): Promise<void> {
  return removeAndOffer(
    `/api/playlists/${playlistId}/items/${videoId}`,
    t('Removed from the playlist'),
    (receipt) => post(`/api/playlists/${playlistId}/items`, receipt),
    after,
  )
}

/** Drop a video from Imported, recoverable to the same place on the page. */
export function removeImported(videoId: string, after?: () => void): Promise<void> {
  return removeAndOffer(
    `/api/imported/${videoId}`,
    t('Removed from imported'),
    (receipt) => post('/api/imported/restore', receipt),
    after,
  )
}

/**
 * Delete a downloaded file.
 *
 * The one undo here that isn't a restore: the file is off the disk, so taking
 * it back means fetching it again, which takes as long as it took the first
 * time. Worth offering anyway — what the click saves you is finding the video
 * again, and the card says "Downloading" so nobody is misled about what's
 * happening.
 */
export function deleteDownload(videoId: string, after?: () => void): Promise<void> {
  return removeAndOffer(
    `/api/downloads/${videoId}`,
    t('Download deleted'),
    (receipt) => post('/api/downloads', receipt),
    after,
  )
}
