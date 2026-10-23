/**
 * Captions remembered per channel — the `caption_memory` setting. Off, every
 * video opens as the last one had them (lib/captionPrefs) on your default
 * languages (lib/captionDefaults). Per channel, a channel you've watched opens
 * the way you last left it there: captions off for one, two tracks for another.
 * A channel with nothing remembered yet opens the usual way.
 *
 * Kept in localStorage beside the other caption prefs, as {channelId: entry}.
 */
export const CHANNEL_CAPTIONS_KEY = 'ytfeed:caption-channels'

export type CaptionMemory = 'last_video' | 'channel_on' | 'channel_tracks'
// What a channel remembers. `lang`/`lang2` are the slots' raw picks ('' = the
// video's own track / no second), AI translation included; only kept under
// 'channel_tracks'.
export type ChannelCaptions = { on: boolean; lang?: string; lang2?: string }

let memory: CaptionMemory = 'last_video'

export function setCaptionMemory(v: unknown) {
  memory = v === 'channel_on' || v === 'channel_tracks' ? v : 'last_video'
}

export function captionMemory(): CaptionMemory { return memory }

function readAll(): Record<string, ChannelCaptions> {
  try {
    const all = JSON.parse(localStorage.getItem(CHANNEL_CAPTIONS_KEY) || '{}')
    return all && typeof all === 'object' && !Array.isArray(all) ? all : {}
  } catch {
    return {}
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

/**
 * What this channel's videos open on, as far as the setting reaches: just `on`
 * under 'channel_on', the tracks too under 'channel_tracks'. Null when the
 * setting is off or the channel has nothing remembered.
 */
export function loadChannelCaptions(channelId: string): ChannelCaptions | null {
  if (memory === 'last_video' || !channelId) return null
  const e = readAll()[channelId]
  if (!e || typeof e.on !== 'boolean') return null
  // Tracks saved under 'channel_tracks' stay stored after a switch to
  // 'channel_on', so switching back finds them again.
  return memory === 'channel_tracks' && typeof e.lang === 'string'
    ? { on: e.on, lang: str(e.lang), lang2: str(e.lang2) }
    : { on: e.on }
}

export function saveChannelCaptions(channelId: string, state: { on: boolean; lang: string; lang2: string }) {
  if (memory === 'last_video' || !channelId) return
  const all = readAll()
  const prev = all[channelId]
  all[channelId] = memory === 'channel_tracks'
    ? state
    // Under 'channel_on' the tracks belong to the defaults; any kept from
    // before are left as they were.
    : { ...prev, on: state.on }
  try {
    localStorage.setItem(CHANNEL_CAPTIONS_KEY, JSON.stringify(all))
  } catch { /* storage disabled — this visit only */ }
}
