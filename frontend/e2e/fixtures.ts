import { test as base, expect, type Page } from '@playwright/test'

/**
 * The specs' `page`, with YouTube taken out of it.
 *
 * The seeded videos are files on disk (seed.py), so playing them needs nothing
 * from YouTube — but the watch page still asks the backend for what only
 * YouTube knows: the description and its chapters, the captions, the comments.
 * Those are answered here, per video, so a spec says what the video has rather
 * than hoping the network agrees. Anything else leaving the machine is
 * refused, which is the browser's half of the dead proxy in serve.sh.
 */

type Cue = { start: number; dur: number; text: string }
type Chapter = { start: number; end: number; title: string }

/** What each seeded video "has on YouTube". A video not listed has nothing. */
export const YOUTUBE: Record<string, { chapters?: Chapter[]; cues?: Cue[] }> = {
  e2eMarks000: {
    chapters: [
      { start: 0, end: 7, title: 'Opening' },
      { start: 7, end: 14, title: 'Middle' },
      { start: 14, end: 20, title: 'Close' },
    ],
    cues: [
      { start: 0, dur: 4, text: 'The first caption.' },
      { start: 4, dur: 4, text: 'The second caption.' },
    ],
  },
}

async function stubYouTube(page: Page) {
  const idOf = (url: string) => new URL(url).pathname.split('/').pop() || ''
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })

  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort())
  await page.route('**/api/feed/description/*', (route) =>
    route.fulfill(json({ description: '', chapters: YOUTUBE[idOf(route.request().url())]?.chapters ?? [] })))
  await page.route('**/api/feed/captions/*', (route) =>
    route.fulfill(json({ cues: YOUTUBE[idOf(route.request().url())]?.cues ?? [], lang: 'en' })))
  await page.route('**/api/feed/caption-langs/*', (route) => {
    const has = !!YOUTUBE[idOf(route.request().url())]?.cues?.length
    return route.fulfill(json({ langs: has ? [{ code: 'en', label: 'English' }] : [], native: has ? 'en' : '' }))
  })
  await page.route('**/api/feed/captions-generate/*', (route) =>
    route.fulfill(json({ status: 'none', covered: 0, duration: 0, lang: '', error: '', supported: false })))
  await page.route('**/api/feed/storyboard/*', (route) => route.fulfill(json({})))
  await page.route('**/api/feed/comments/*', (route) =>
    route.fulfill(json({ disabled: false, fetched: 0, capped: false, has_replies: true, threads: [] })))
}

export const test = base.extend({
  page: async ({ page }, use) => {
    await stubYouTube(page)
    await use(page)
  },
})

export { expect }

/** The <video> the watch page plays a download in. */
export const player = (page: Page) => page.locator('video').first()

/** Open a seeded video's watch page and wait for its file to be playing. */
export async function watch(page: Page, videoId: string) {
  await page.goto(`/watch/${videoId}`)
  const video = player(page)
  await expect(video).toHaveAttribute('src', new RegExp(`/api/downloads/${videoId}/file`))
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0)
  return video
}

/** Put the play head somewhere, and wait for it to land. */
export async function seek(page: Page, seconds: number) {
  await player(page).evaluate(async (v: HTMLVideoElement, t) => {
    v.currentTime = t
    await new Promise((r) => v.addEventListener('seeked', r, { once: true }))
  }, seconds)
}

/** A sidebar entry. Its name carries a count when there's something in it
 *  ("Watch Later 1"). */
export const nav = (page: Page, name: string) =>
  page.getByRole('button', { name: new RegExp(`^${name}( \\d+)?$`) }).first()

export const pause = (page: Page) => player(page).evaluate((v: HTMLVideoElement) => v.pause())
export const currentTime = (page: Page) => player(page).evaluate((v: HTMLVideoElement) => v.currentTime)

/** Take away a video's bookmarks and passages, so a spec starts from none
 *  whatever ran before it — `b` on a bookmarked moment removes it. */
export async function clearMarks(page: Page, videoId: string) {
  const api = page.request
  for (const b of await (await api.get(`/api/bookmarks/${videoId}`)).json()) {
    await api.delete(`/api/bookmarks/id/${b.id}`)
  }
  for (const l of await (await api.get(`/api/bookmarks/${videoId}/loops`)).json()) {
    await api.delete(`/api/bookmarks/${videoId}/loops/id/${l.id}`)
  }
}
