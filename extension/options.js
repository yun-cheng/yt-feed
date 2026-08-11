/*
 * The options page: the app's address and this person's API key.
 *
 * Both live in `chrome.storage.local` under one key, so `background.js` reads a
 * single object and a half-written pair can't exist. The worker is the only
 * thing that reads them — `open-in-app.js` asks it rather than reading storage
 * itself, which is what finally ends the duplicated APP_ORIGIN constant.
 */
const CONFIG_KEY = 'config'
const DEFAULT_ORIGIN = 'http://localhost:5173'

const $origin = document.getElementById('origin')
const $key = document.getElementById('key')
const $save = document.getElementById('save')
const $status = document.getElementById('status')

function say(text, bad = false) {
  $status.textContent = text
  $status.className = bad ? 'bad' : ''
  if (!bad) setTimeout(() => { $status.textContent = '' }, 2500)
}

async function load() {
  const { [CONFIG_KEY]: config = {} } = await chrome.storage.local.get(CONFIG_KEY)
  $origin.value = config.origin || DEFAULT_ORIGIN
  $key.value = config.apiKey || ''
}

/** Trim the trailing slash: everything downstream builds `${origin}/api/…`. */
function cleanOrigin(raw) {
  return (raw || '').trim().replace(/\/+$/, '') || DEFAULT_ORIGIN
}

async function save() {
  const origin = cleanOrigin($origin.value)
  const apiKey = $key.value.trim()

  try {
    new URL(origin)
  } catch {
    say("That doesn't look like an address.", true)
    return
  }

  $save.disabled = true
  await chrome.storage.local.set({ [CONFIG_KEY]: { origin, apiKey } })
  $origin.value = origin

  // Check it rather than just storing it — a typo'd key fails silently
  // otherwise, and the first you'd know is history quietly not being recorded.
  try {
    const res = await fetch(`${origin}/api/auth/me`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const me = await res.json()
    if (me.signed_in) say(`Saved — talking to the app as ${me.email || me.name || 'you'}.`)
    else if (apiKey) say('Saved, but the app did not recognise that key.', true)
    else say('Saved. No key set — the app will answer only if it has one account.')
  } catch (err) {
    say(`Saved, but the app did not answer (${err}).`, true)
  } finally {
    $save.disabled = false
  }
}

$save.addEventListener('click', save)
document.addEventListener('DOMContentLoaded', load)
load()
