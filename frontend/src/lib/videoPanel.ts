/**
 * Which tab the panel over the video opens on — the `video_panel_tab` setting.
 * Installed at startup by DefaultsLoader and again when Settings saves, the
 * same way the caption defaults are; the watch page reads it for each video.
 */
export type VideoPanelTab = 'info' | 'comments' | 'transcript' | 'ask'

const TABS: readonly VideoPanelTab[] = ['info', 'comments', 'transcript', 'ask']
const FALLBACK: VideoPanelTab = 'comments'

let current: VideoPanelTab = FALLBACK

/** Anything the frontend doesn't know as a tab reads as the built-in default. */
export function setVideoPanelDefault(value: unknown) {
  current = TABS.includes(value as VideoPanelTab) ? (value as VideoPanelTab) : FALLBACK
}

export function videoPanelDefault(): VideoPanelTab { return current }
