/**
 * Adding a channel by hand — the two calls behind all three ways in.
 *
 * They're here rather than in a component because three places need them: the
 * add dialog on the Channels page, the page you land on after clicking a channel
 * this app doesn't hold, and (through the extension's service worker) the pill on
 * YouTube's own channel pages.
 */
import { apiFetch } from './api'

export type ChannelLookup = {
  youtube_id: string
  title: string
  description: string
  thumbnail_url: string
  subscriber_count: number
  topics: string[]
  // Whether this app already holds the channel, and how it got here —
  // "manual" if it was added by hand, "subscription" if it came from YouTube,
  // "" if we don't hold it at all.
  known: boolean
  source: string
}

/** Who is this? Resolves a link, an @handle or a bare id. Writes nothing. */
export async function lookupChannel(query: string): Promise<ChannelLookup | null> {
  // Quiet: "that isn't a channel" is this call's normal negative answer, and the
  // dialog says so in place, where you're looking.
  const res = await apiFetch(`/api/channels/lookup?q=${encodeURIComponent(query)}`, { quiet: true })
  if (!res.ok) return null
  return res.json()
}

export type AddChannelResult = ChannelLookup & {
  // True when it was already here, in which case nothing was added.
  already: boolean
  // How many of its uploads the first scan brought in.
  added_videos: number
}

export async function addChannel(query: string): Promise<AddChannelResult | null> {
  const res = await apiFetch('/api/channels/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  if (!res.ok) return null
  return res.json()
}
