/*
 * The one thing a content script can't do: talk to the app's API.
 *
 * A fetch from `open-in-app.js` carries `Origin: https://www.youtube.com`, and
 * the API allows the app's own origin only — so the browser blocks the reply.
 * Fetches from here don't go through CORS at all: the extension's own
 * `host_permissions` are the check instead. Hence this file, which exists to
 * relay one message and does nothing else.
 *
 * `APP_ORIGIN` is duplicated from `open-in-app.js` rather than shared, because
 * a service worker and a content script have no common scope short of adding a
 * module loader to a five-file, no-build extension. Change both, or nothing:
 * the button opens the wrong port while the save still works, which reads as a
 * baffling bug.
 */
const APP_ORIGIN = 'http://localhost:5173'

/*
 * The app's dev server proxies /api to the backend, so one origin covers both
 * and there's no second port to keep in step.
 */
async function saveWatchLater(videoId) {
  const res = await fetch(`${APP_ORIGIN}/api/watch-later/by-id/${videoId}`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'save-watch-later') return

  saveWatchLater(msg.videoId)
    .then((data) => sendResponse({ ok: true, ...data }))
    // The app being closed is the everyday case, not an exception: report it
    // like any other failure and let the button say so.
    .catch((err) => sendResponse({ ok: false, error: String(err) }))

  // Keeps the message channel open for the async reply above.
  return true
})
