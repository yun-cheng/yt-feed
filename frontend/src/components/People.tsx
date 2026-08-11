import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '../lib/api'

type Person = {
  id: number
  name: string
  email: string
  google: boolean
  is_you: boolean
}

/**
 * The link to send someone.
 *
 * Composed here rather than by the API on purpose: the request reaches the
 * backend through the dev server's proxy, which doesn't pass the browser's host
 * along, so the server would build `http://localhost:8000/...` — an address only
 * the machine it runs on can open. This page is being viewed at whatever address
 * the household actually uses, which is the one that works.
 */
function loginUrl(token: string) {
  return `${window.location.origin}/api/users/join/${token}`
}

/**
 * Who shares this app, and the links that let them in.
 *
 * Adding someone hands back a link rather than asking you to invent a password
 * for them: Google sign-in can't reach past the server itself (it only accepts
 * an http callback on localhost), and a household shouldn't have to choose
 * credentials to watch videos on a machine in the next room.
 *
 * The link is shown once here and again on demand, because it IS the credential
 * — there is nothing else to look up if it's lost, only a new one to mint.
 */
export default function People() {
  const [people, setPeople] = useState<Person[] | null>(null)
  const [name, setName] = useState('')
  const [link, setLink] = useState<{ id: number; url: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const load = useCallback(() => {
    apiFetch('/api/users', { quiet: true })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setPeople(d ?? []))
      .catch(() => setPeople([]))
  }, [])

  useEffect(load, [load])

  async function add() {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    try {
      const res = await apiFetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      })
      if (res.ok) {
        const person = await res.json()
        setLink({ id: person.id, url: loginUrl(person.login_token) })
        setName('')
        load()
      }
    } finally {
      setBusy(false)
    }
  }

  async function newLink(id: number) {
    const res = await apiFetch(`/api/users/${id}/link`, { method: 'POST' })
    if (res.ok) setLink({ id, url: loginUrl((await res.json()).login_token) })
  }

  async function remove(person: Person) {
    const ok = window.confirm(
      `Remove ${person.name}? Their history, playlists, tags and saved videos go too. ` +
      `Nothing shared — channels, videos, downloads — is touched.`
    )
    if (!ok) return
    const res = await apiFetch(`/api/users/${person.id}`, { method: 'DELETE' })
    if (res.ok) {
      if (link?.id === person.id) setLink(null)
      load()
    }
  }

  if (!people) return null

  return (
    <section className="mb-8">
      <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-[#777]">
        People
      </h3>

      <p className="mb-3 text-xs leading-relaxed text-[#777]">
        Everyone here keeps their own history, playlists, tags and saved videos.
        Channels and downloads are shared &mdash; one copy, fetched once.
      </p>

      <div className="flex flex-col divide-y divide-[#222] rounded-xl border border-[#2a2a2a]">
        {people.map((p) => (
          <div key={p.id} className="flex items-center gap-3 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <span className="text-sm text-white">{p.name}</span>
              {p.is_you && <span className="ml-2 text-xs text-[#777]">you</span>}
              <p className="text-xs text-[#666]">
                {p.google ? p.email || 'signs in with Google' : 'signs in with a link'}
              </p>
            </div>
            {!p.google && (
              <button
                onClick={() => newLink(p.id)}
                className="flex-shrink-0 cursor-pointer rounded-full border border-[#3f3f3f] px-3 py-1 text-xs text-[#ddd] hover:border-[#666]"
              >
                {link?.id === p.id ? 'New link' : 'Get link'}
              </button>
            )}
            {!p.is_you && (
              <button
                onClick={() => remove(p)}
                className="flex-shrink-0 cursor-pointer rounded-full border border-[#3f3f3f] px-3 py-1 text-xs text-[#e0a0a0] hover:border-[#5c2b2b]"
              >
                Remove
              </button>
            )}
          </div>
        ))}
      </div>

      {link && (
        <div className="mt-3 rounded-xl border border-[#2a2a2a] bg-[#161616] px-3 py-3">
          <p className="text-xs text-[#aaa]">
            Send them this. Opening it signs them in and keeps them signed in, on
            as many devices as they like. Anyone with the link is them, so send it
            the way you&rsquo;d send a password &mdash; and use{' '}
            <span className="text-[#ddd]">New link</span> if it goes astray.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg border border-[#3f3f3f] bg-[#1c1c1c] px-3 py-2 font-mono text-xs text-[#ddd]">
              {link.url}
            </code>
            <button
              onClick={() => {
                navigator.clipboard.writeText(link.url)
                setCopied(true)
                setTimeout(() => setCopied(false), 2000)
              }}
              className="flex-shrink-0 cursor-pointer rounded-full bg-white px-4 py-2 text-xs font-medium text-black"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add() }}
          placeholder="Add someone — their name"
          className="min-w-0 flex-1 rounded-lg border border-[#3f3f3f] bg-[#1c1c1c] px-3 py-2 text-sm text-white placeholder:text-[#666] focus:border-[#666] focus:outline-none"
        />
        <button
          onClick={add}
          disabled={!name.trim() || busy}
          className="flex-shrink-0 cursor-pointer rounded-full bg-white px-4 py-2 text-xs font-medium text-black disabled:opacity-40"
        >
          Add
        </button>
      </div>
    </section>
  )
}
