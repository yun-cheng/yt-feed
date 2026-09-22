import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '../lib/api'
import { t } from '../lib/i18n'
import SetupPage from './SetupPage'

type Me = { signed_in: boolean; resolved: boolean; name?: string }

/**
 * Shows the app, the way into it, or — on a deployment nobody owns yet — the way
 * to claim it.
 *
 * Gates on `resolved` rather than `signed_in`: the app answers for the sole
 * account on a machine that has only one, so a household of one never sees this
 * screen and nothing about the single-person setup changes. It appears the
 * moment a second account exists and the browser isn't any of them — which,
 * before this, was a page of failed requests with no explanation.
 *
 * The third state is what a deployable app added. An empty database resolves
 * nobody, which used to land here — on a screen telling you to open the link you
 * were sent, when nobody exists to have sent you one. So an unresolved browser
 * asks `/api/setup/status` first, and a deployment with no owner gets the setup
 * screen instead. Only asked when unresolved: a signed-in app never makes the
 * call, since the answer can only be "claimed".
 *
 * Two ways in once it IS claimed, and which applies isn't the visitor's choice.
 * Google only accepts an OAuth callback over http on `localhost`, so it works for
 * whoever runs the server and nobody else; everyone else opens a login link they
 * were sent. The screen offers both and says which is which, because a family
 * member clicking "Sign in with Google" and landing on an error would have no
 * idea why.
 */
export default function SignInGate({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null)
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null)

  const load = useCallback(() => {
    apiFetch('/api/auth/me', { quiet: true })
      .then((r) => (r.ok ? r.json() : { signed_in: false, resolved: false }))
      .then((d: Me) => setMe(d))
      // A backend that isn't up is not a signed-out state — showing the way in
      // would be a lie, and the app's own error handling says it better.
      .catch(() => setMe({ signed_in: true, resolved: true }))
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    // Nothing to ask while we're resolved, or before we know.
    if (me === null || me.resolved) { setNeedsSetup(false); return }
    let live = true
    apiFetch('/api/setup/status', { quiet: true })
      .then((r) => (r.ok ? r.json() : null))
      // An unreachable or older backend is treated as claimed: offering to claim
      // a deployment that may already have an owner is the worse guess.
      .then((d) => { if (live) setNeedsSetup(d ? !d.claimed : false) })
      .catch(() => { if (live) setNeedsSetup(false) })
    return () => { live = false }
  }, [me])

  if (me === null || needsSetup === null) {
    return <div className="flex h-dvh items-center justify-center text-sm text-[#777]">{t('Loading…')}</div>
  }
  if (me.resolved) return <>{children}</>
  if (needsSetup) return <SetupPage onClaimed={load} />

  return (
    <div className="flex h-dvh items-center justify-center bg-[#0f0f0f] px-6">
      <div className="w-full max-w-sm text-center">
        <h1 className="text-2xl font-bold text-white">YT Feed</h1>
        <p className="mt-2 text-sm leading-relaxed text-[#aaa]">
          {t('This app keeps your own history, playlists and channels separate from everyone else’s. Open the link you were sent to pick yours up.')}
        </p>

        <div className="mt-8 rounded-xl border border-[#2a2a2a] bg-[#161616] px-4 py-3 text-left">
          <p className="text-xs font-medium uppercase tracking-wide text-[#777]">
            {t('No link?')}
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-[#888]">
            {t('Ask whoever set this up to add you — Settings → People — and send you your link. It works on as many devices as you like.')}
          </p>
        </div>

        <a
          href="/api/auth/login"
          className="mt-4 inline-block text-xs text-[#777] underline underline-offset-4 hover:text-[#aaa]"
        >
          {t('Or sign in with Google (works on the server itself)')}
        </a>
      </div>
    </div>
  )
}
