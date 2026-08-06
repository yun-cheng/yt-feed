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
