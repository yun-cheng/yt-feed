/**
 * The first screen of a deployment nobody owns yet.
 *
 * A fresh container has an empty database, so there is nobody to sign in as and
 * no key to sign in with. The way in is a token the backend printed to its own
 * log on first boot — a channel that reaches the person who ran `docker compose
 * up` and nobody else, which is exactly the distinction that makes this safe on a
 * public URL. Presenting it creates the first account and signs this browser in.
 *
 * The OAuth fields are here rather than left to Settings only because of what
 * happens next: the first thing an owner wants is their subscriptions, and that
 * needs a Google client. Both are optional and skipping them costs nothing —
 * Settings → Connections is the same form.
 *
 * `token` comes from the URL when the deployer clicks the link in the log, so the
 * common path is paste-nothing: open the link, press the button.
 */
import { useEffect, useState } from 'react'
import { apiFetch } from '../lib/api'
import { t } from '../lib/i18n'

function tokenFromUrl(): string {
  try {
    return new URLSearchParams(window.location.search).get('token') ?? ''
  } catch {
    return ''
  }
}

export default function SetupPage({ onClaimed }: { onClaimed: () => void }) {
  const [token, setToken] = useState(tokenFromUrl)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showOauth, setShowOauth] = useState(false)

  // Say whether the token in the URL is the right one before the button is
  // pressed, so a stale link from an older container reads as a stale link
  // rather than as a refusal to work.
  const [accepted, setAccepted] = useState<boolean | null>(null)
  useEffect(() => {
    if (!token) { setAccepted(null); return }
    let live = true
    apiFetch('/api/setup/status', { quiet: true, headers: { 'X-Setup-Token': token } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live) setAccepted(d ? Boolean(d.token_accepted) : null) })
      .catch(() => { if (live) setAccepted(null) })
    return () => { live = false }
  }, [token])

  async function claim() {
    setBusy(true)
    setError(null)
    try {
      const res = await apiFetch('/api/setup/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        quiet: true,
        body: JSON.stringify({
          token: token.trim(),
          google_client_id: clientId.trim(),
          google_client_secret: clientSecret.trim(),
        }),
      })
      if (!res.ok) {
        const detail = await res.json().catch(() => null)
        setError(detail?.detail ?? t('That didn’t work.'))
        return
      }
      // The URL still carries the token; drop it before handing over to the app
      // so it isn't in history or in a link somebody copies out of the bar.
      window.history.replaceState(null, '', '/')
      onClaimed()
    } catch {
      setError(t('Could not reach the server.'))
    } finally {
      setBusy(false)
    }
  }

  const field = 'w-full rounded-lg border border-[#3f3f3f] bg-[#1c1c1c] px-3 py-2 font-mono text-xs text-white placeholder:text-[#555] disabled:opacity-50'

  return (
    <div className="flex min-h-dvh items-center justify-center bg-[#0f0f0f] px-6 py-10">
      <div className="w-full max-w-md">
        <h1 className="text-2xl font-bold text-white">YT Feed</h1>
        <p className="mt-2 text-sm leading-relaxed text-[#aaa]">
          {t('Nobody owns this deployment yet. Claim it to become its owner — after that, nobody else can sign in unless you invite them.')}
        </p>

        <div className="mt-6">
          <label className="text-sm font-medium text-white">{t('Setup token')}</label>
          <p className="mt-0.5 text-xs leading-relaxed text-[#777]">
            {t('Printed in the server’s log when it first started. With Docker: docker compose logs app | grep setup')}
          </p>
          <input
            value={token}
            disabled={busy}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setToken(e.target.value)}
            className={`mt-2 ${field}`}
          />
          {accepted === false && (
            <p className="mt-1.5 text-xs text-[#e0a0a0]">
              {t('That isn’t the token this server is expecting.')}
            </p>
          )}
          {accepted === true && (
            <p className="mt-1.5 text-xs text-[#7ac77a]">{t('Token accepted.')}</p>
          )}
        </div>

        {showOauth ? (
          <div className="mt-6 rounded-xl border border-[#2a2a2a] bg-[#161616] px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wide text-[#777]">
              {t('Sign in with Google (optional)')}
            </p>
            <p className="mt-1.5 text-xs leading-relaxed text-[#888]">
              {t('Needed only to import your YouTube subscriptions. Create an OAuth client (type: Web application) in the Google Cloud console, enable the YouTube Data API, and register this address + /api/auth/callback as a redirect URI. You can add this later in Settings.')}
            </p>
            <input
              value={clientId}
              disabled={busy}
              spellCheck={false}
              autoComplete="off"
              placeholder={t('Client ID')}
              onChange={(e) => setClientId(e.target.value)}
              className={`mt-2 ${field}`}
            />
            <input
              type="password"
              value={clientSecret}
              disabled={busy}
              spellCheck={false}
              autoComplete="off"
              placeholder={t('Client secret')}
              onChange={(e) => setClientSecret(e.target.value)}
              className={`mt-2 ${field}`}
            />
          </div>
        ) : (
          <button
            onClick={() => setShowOauth(true)}
            className="mt-4 cursor-pointer text-xs text-[#777] underline underline-offset-4 hover:text-[#aaa]"
          >
            {t('Add a Google OAuth client too (optional)')}
          </button>
        )}

        {error && (
          <div className="mt-4 rounded-lg border border-[#5c2b2b] bg-[#2a1a1a] px-3 py-2 text-xs text-[#e0a0a0]">
            {error}
          </div>
        )}

        <button
          disabled={busy || !token.trim()}
          onClick={() => void claim()}
          className="mt-6 w-full cursor-pointer rounded-full bg-white px-4 py-2.5 text-sm font-medium text-black disabled:cursor-default disabled:opacity-40"
        >
          {busy ? t('Claiming…') : t('Claim this deployment')}
        </button>

        <p className="mt-4 text-xs leading-relaxed text-[#666]">
          {t('Everything else — the OpenRouter key for AI features, YouTube cookies, search — is set from Settings → Connections once you’re in.')}
        </p>
      </div>
    </div>
  )
}
