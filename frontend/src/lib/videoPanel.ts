/**
 * Which tab the panel over the video opens on — the `video_panel_tab` setting.
 * Installed at startup by DefaultsLoader and again when Settings saves, the
 * same way the caption defaults are; the watch page reads it for each video.
 */
export type VideoPanelTab = 'info' | 'comments' | 'transcript' | 'ask'

/** Every tab the panel can show. Chapters and Bookmarks are lists of moments in
 *  this video, there to jump between, Repeat its saved passages, and Notes is
 *  what you write about it — each picked on the video rather than opened on. */
export type PanelTabKey = VideoPanelTab | 'chapters' | 'bookmarks' | 'loops' | 'notes'

const TABS: readonly VideoPanelTab[] = ['info', 'comments', 'transcript', 'ask']
const FALLBACK: VideoPanelTab = 'comments'

let current: VideoPanelTab = FALLBACK

/** Anything the frontend doesn't know as a tab reads as the built-in default. */
export function setVideoPanelDefault(value: unknown) {
  current = TABS.includes(value as VideoPanelTab) ? (value as VideoPanelTab) : FALLBACK
}

export function videoPanelDefault(): VideoPanelTab { return current }
