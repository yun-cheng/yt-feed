/**
 * Deploying it yourself, from the browser's side: the key field and the claim
 * screen.
 *
 * The property worth pinning in both is that they work with information the
 * server will not give them. A secret is never returned, so `SecretField` starts
 * empty on every load and has to say "set" some other way — and an empty field
 * therefore cannot mean "clear this", which is why clearing is its own button.
 * The claim screen exists because an empty database resolves nobody, which used
 * to land on a sign-in screen telling you to open a link nobody had sent.
 */
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import SecretField from '../components/SecretField'
import SignInGate from '../components/SignInGate'

function ok(payload: unknown) {
  return {
    ok: true,
    status: 200,
    clone: () => ({ text: async () => JSON.stringify(payload) }),
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ok({})))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('SecretField', () => {
  const save = () => screen.getByText('Save')

  it('starts empty even when a key is set, because it was never sent one', () => {
    const { container } = render(
      <SecretField settingKey="openrouter_api_key" view={{ set: true, hint: '…mnop' }}
                   busy={false} onSave={vi.fn()} />,
    )

    expect(container.querySelector('input')).toHaveValue('')
    // What stands in for the value: that there is one, and which one.
    expect(screen.getByText('Set')).toBeInTheDocument()
    expect(screen.getByText('…mnop')).toBeInTheDocument()
  })

  it('says so when there is no key', () => {
    render(<SecretField settingKey="k" view={{ set: false }} busy={false} onSave={vi.fn()} />)

    expect(screen.getByText('Not set')).toBeInTheDocument()
  })

  it('will not save an untouched field', () => {
    // Which is the whole reason clearing is a separate button: an empty field is
    // what "I didn't touch this" looks like, so it cannot also mean "remove it".
    render(<SecretField settingKey="k" view={{ set: true, hint: '…abcd' }} busy={false} onSave={vi.fn()} />)

    expect(save()).toBeDisabled()
  })

  it('saves what you typed, and empties itself afterwards', async () => {
    const onSave = vi.fn(async () => true)
    const { container } = render(
      <SecretField settingKey="k" view={{ set: false }} busy={false} onSave={onSave} />,
    )
    const input = container.querySelector('input') as HTMLInputElement

    fireEvent.change(input, { target: { value: '  sk-or-v1-abcd  ' } })
    await act(async () => { fireEvent.click(save()) })

    expect(onSave).toHaveBeenCalledWith('  sk-or-v1-abcd  ')
    // Cleared, so the field doesn't sit there looking like it holds the key.
    expect(input.value).toBe('')
  })

  it('keeps what you typed when the save failed', async () => {
    const onSave = vi.fn(async () => false)
    const { container } = render(
      <SecretField settingKey="k" view={{ set: false }} busy={false} onSave={onSave} />,
    )
    const input = container.querySelector('input') as HTMLInputElement

    fireEvent.change(input, { target: { value: 'sk-or-v1-abcd' } })
    await act(async () => { fireEvent.click(save()) })

    // Clearing it would throw away a 40-character paste on a failure the person
    // is about to retry.
    expect(input.value).toBe('sk-or-v1-abcd')
  })

  it('clears with an empty string, as its own action', async () => {
    const onSave = vi.fn(async () => true)
    render(<SecretField settingKey="k" view={{ set: true, hint: '…abcd' }} busy={false} onSave={onSave} />)

    await act(async () => { fireEvent.click(screen.getByText('Clear')) })

    expect(onSave).toHaveBeenCalledWith('')
  })

  it('offers no Clear for a key that came from .env', () => {
    // There is nothing here to clear — the value is in a file, and a button that
    // appeared to remove it and then didn't would be worse than no button.
    render(
      <SecretField settingKey="k" view={{ set: true, hint: '…abcd', from_env: true }}
                   busy={false} onSave={vi.fn()} />,
    )

    expect(screen.queryByText('Clear')).toBeNull()
    expect(screen.getByText('from .env')).toBeInTheDocument()
  })

  it('offers Test only where the server can check it', () => {
    const { rerender } = render(
      <SecretField settingKey="k" view={{ set: true }} busy={false} onSave={vi.fn()} />,
    )
    expect(screen.queryByText('Test')).toBeNull()

    rerender(
      <SecretField settingKey="k" view={{ set: true }} testable busy={false} onSave={vi.fn()} />,
    )
    expect(screen.getByText('Test')).toBeInTheDocument()
  })

  it('reports what the check said, in place', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(ok({ ok: false, text: 'OpenRouter rejected the key.' }))
    render(
      <SecretField settingKey="openrouter_api_key" view={{ set: true }} testable
                   busy={false} onSave={vi.fn()} />,
    )

    await act(async () => { fireEvent.click(screen.getByText('Test')) })

    expect(fetch).toHaveBeenCalledWith('/api/settings/test/openrouter_api_key',
      expect.objectContaining({ method: 'POST' }))
    expect(screen.getByText('OpenRouter rejected the key.')).toBeInTheDocument()
  })

  it('renders a textarea for something as long as a cookie jar', () => {
    const { container } = render(
      <SecretField settingKey="youtube_cookies" view={{ set: false }} multiline
                   busy={false} onSave={vi.fn()} />,
    )

    expect(container.querySelector('textarea')).not.toBeNull()
    expect(container.querySelector('input')).toBeNull()
  })

  it('masks a one-line key, so it isn’t left on screen', () => {
    const { container } = render(
      <SecretField settingKey="k" view={{ set: false }} busy={false} onSave={vi.fn()} />,
    )

    expect(container.querySelector('input')).toHaveAttribute('type', 'password')
  })
})

describe('SignInGate', () => {
  /** Answer `/api/auth/me` and `/api/setup/status` by path. */
  function server(me: unknown, setup: unknown) {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/setup/status')) return ok(setup)
      return ok(me)
    })
  }

  it('shows the app when the browser resolves to somebody', async () => {
    server({ signed_in: true, resolved: true }, { claimed: true })
    render(<SignInGate><p>the feed</p></SignInGate>)

    expect(await screen.findByText('the feed')).toBeInTheDocument()
  })

  it('offers to claim a deployment nobody owns', async () => {
    // Rather than the sign-in screen, which asks you to open a link — on a fresh
    // deployment there is nobody who could have sent you one.
    server({ signed_in: false, resolved: false }, { claimed: false })
    render(<SignInGate><p>the feed</p></SignInGate>)

    expect(await screen.findByText('Claim this deployment')).toBeInTheDocument()
  })

  it('asks a stranger for their link once the deployment is claimed', async () => {
    server({ signed_in: false, resolved: false }, { claimed: true })
    render(<SignInGate><p>the feed</p></SignInGate>)

    expect(await screen.findByText('No link?')).toBeInTheDocument()
    expect(screen.queryByText('Claim this deployment')).toBeNull()
  })

  it('treats a server it cannot ask as claimed', async () => {
    // Offering to claim a deployment that may already have an owner is the worse
    // of the two guesses.
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).startsWith('/api/setup/status')) throw new Error('offline')
      return ok({ signed_in: false, resolved: false })
    })
    render(<SignInGate><p>the feed</p></SignInGate>)

    expect(await screen.findByText('No link?')).toBeInTheDocument()
  })

  it('shows the app once the claim goes through', async () => {
    server({ signed_in: false, resolved: false }, { claimed: false })
    render(<SignInGate><p>the feed</p></SignInGate>)
    await screen.findByText('Claim this deployment')

    // The claim signs this browser in, so the gate re-asks and lets it through.
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/setup/claim')) return ok({ claimed: true, id: 1 })
      if (url.startsWith('/api/setup/status')) return ok({ claimed: true })
      return ok({ signed_in: true, resolved: true })
    })

    const token = document.querySelector('input') as HTMLInputElement
    fireEvent.change(token, { target: { value: 'the-token' } })
    await act(async () => { fireEvent.click(screen.getByText('Claim this deployment')) })

    await waitFor(() => expect(screen.getByText('the feed')).toBeInTheDocument())
  })
})
