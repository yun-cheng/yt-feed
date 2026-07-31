/**
 * Local folders — a directory on the machine running the backend, browsed as a
 * feed. Shapes and fetch helpers shared by the folder list, the folder page and
 * the local watch overlay.
 *
 * A local video is deliberately NOT a VideoItem: it has no channel, no stats and
 * no youtube_id, and pretending otherwise would put it through code paths (the
 * embed, watch history, playlists) that have nothing to work with.
 */
import { apiFetch } from './api'

export type LocalFolder = {
  id: number
  path: string
  name: string
  video_count: number
  // False when the directory can't be read right now — an unmounted drive, or a
  // folder that moved. The rows stay; the page says so.
  available: boolean
  created_at: string | null
}

export type LocalVideo = {
  id: string
  folder_id: number
  title: string
  rel_path: string
  sub_dir: string
  duration_seconds: number
  // False = the duration hasn't been measured yet (see the scanning poll below),
  // not "zero seconds long".
  probed: boolean
  filesize: number
  modified_at: string
  position_seconds: number
  watched: boolean
  file_url: string
  thumbnail_url: string
}

export type FolderVideos = {
  folder: LocalFolder
  videos: LocalVideo[]
  // True while the backend is still measuring durations. Reading one means
  // reading the file, which on a cloud-synced drive streams it down, so the
  // listing returns first and the page polls until this goes false.
  scanning: boolean
}

export async function fetchFolders(): Promise<LocalFolder[]> {
  const res = await apiFetch('/api/local/folders')
  if (!res.ok) return []
  return res.json()
}

export async function fetchFolderVideos(folderId: number, rescan = true): Promise<FolderVideos | null> {
  const res = await apiFetch(`/api/local/folders/${folderId}/videos?rescan=${rescan}`, { quiet: !rescan })
  if (!res.ok) return null
  return res.json()
}

/** How much of a video has been watched, 0–1 (for the card's resume bar). */
export function watchedRatio(v: LocalVideo): number {
  if (v.watched) return 1
  if (!v.duration_seconds || !v.position_seconds) return 0
  return Math.min(1, v.position_seconds / v.duration_seconds)
}

export function formatSize(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`
  return `${bytes} B`
}
