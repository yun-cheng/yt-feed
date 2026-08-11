/*
 * Tells the app the clean-embed stylesheet is in place.
 *
 * Timing is the whole reason this is a content script and not a message. The
 * app has to know BEFORE it builds the player: `controls` is a playerVar, baked
 * into the iframe URL at construction, so an answer that arrives one round-trip
 * later is an answer that arrives too late. A content script at document_start
 * runs before any page script, so the flag is simply there when the app boots —
 * no promise, no re-render, no rebuilding the iframe.
 *
 * Reading a DOM attribute also keeps this browser-agnostic and needs no pinned
 * extension ID, which chrome.runtime messaging would.
 *
 * The value is a capability version, not a boolean: bump it if the app ever has
 * to tell an old extension from a new one.
 */
document.documentElement.dataset.ytfeedEmbedClean = '1'


/*
 * Pick up who this browser is signed in as, so you never have to paste a key.
 *
 * This script runs ON the app's own pages, which is the one place a fetch to
 * its API is SAME-ORIGIN and therefore carries the session cookie. Nothing else
 * in the extension can do that: the service worker's requests come from the
 * extension's own origin, and the content script on youtube.com is a different
 * site again — both get a request without the cookie, which is exactly why the
 * key had to be copied across by hand.
 *
 * So: open the app, and the extension knows who you are. The options page stays
 * for the cases this can't reach — an app served from an address the extension
 * has no host permission for, or a key you want to set deliberately.
 *
 * `document_start` is too early for this (the app hasn't booted, and a signed-out
 * page has nothing to give), so it waits for load and asks then.
 */
async function shareIdentity() {
  try {
    const res = await fetch('/api/auth/api-key', { credentials: 'same-origin' })
    if (!res.ok) return  // signed out, or an older app — leave what's stored
    const { api_key: apiKey } = await res.json()
    if (!apiKey) return
    await chrome.runtime.sendMessage({
      type: 'app-identity',
      origin: location.origin,
      apiKey,
    })
  } catch {
    // The extension may be mid-reload, or this isn't the app at all. Both are
    // ordinary: the stored config is still there and still works.
  }
}

if (document.readyState === 'complete') shareIdentity()
else addEventListener('load', shareIdentity)
