import { render, screen, act, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import NotificationBell from '../components/NotificationBell'
import { refreshNotifications, clearNotifications } from '../hooks/notificationStore'

const ROW = {
  id: 1, kind: 'summary', title: 'Summary ready', body: 'A talk about pricing',
  video_id: 'abc', thumbnail_url: 'https://i.ytimg.com/vi/abc/mqdefault.jpg',
  read: false, created_at: new Date().toISOString(),
}

function serve(payload: unknown) {
  globalThis.fetch = vi.fn(async () => ({
    ok: true, status: 200, json: async () => payload, clone: () => ({ text: async () => '' }),
  })) as unknown as typeof fetch
}

async function mount(payload: unknown) {
  serve(payload)
  render(<NotificationBell />)
  await act(async () => { await refreshNotifications() })
}

afterEach(async () => {
  serve({ notifications: [], unread: 0 })
  await act(async () => { await clearNotifications() })
  vi.restoreAllMocks()
})

describe('NotificationBell', () => {
  it('shows the unread count on the bell', async () => {
    await mount({ notifications: [ROW], unread: 1 })
    expect(screen.getByLabelText('Notifications (1 unread)')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
  })

  it('caps the badge rather than widening it', async () => {
    await mount({ notifications: [ROW], unread: 42 })
    expect(screen.getByText('9+')).toBeInTheDocument()
  })

  it('says so when there is nothing rather than opening empty', async () => {
    await mount({ notifications: [], unread: 0 })
    fireEvent.click(screen.getByLabelText('Notifications'))
    expect(screen.getByText('Nothing yet.')).toBeInTheDocument()
  })

  it('lists what landed', async () => {
    await mount({ notifications: [ROW], unread: 1 })
    fireEvent.click(screen.getByLabelText('Notifications (1 unread)'))
    expect(screen.getByText('Summary ready')).toBeInTheDocument()
    expect(screen.getByText('A talk about pricing')).toBeInTheDocument()
  })

  it('opening it clears the badge — the badge means "since you looked"', async () => {
    await mount({ notifications: [ROW], unread: 1 })
    await act(async () => { fireEvent.click(screen.getByLabelText('Notifications (1 unread)')) })
    await waitFor(() => expect(screen.getByLabelText('Notifications')).toBeInTheDocument())
  })

  it('a summary row opens the video on its Ask panel', async () => {
    await mount({ notifications: [ROW], unread: 1 })
    const seen: unknown[] = []
    const onOpen = (e: Event) => seen.push((e as CustomEvent).detail)
    window.addEventListener('app:open-video', onOpen)
    try {
      await act(async () => { fireEvent.click(screen.getByLabelText('Notifications (1 unread)')) })
      fireEvent.click(screen.getByText('Summary ready'))
      expect(seen).toEqual([{ videoId: 'abc', panel: 'ask' }])
    } finally {
      window.removeEventListener('app:open-video', onOpen)
    }
  })

  it('a failure row has nowhere useful to send you, so it does not', async () => {
    await mount({
      notifications: [{ ...ROW, kind: 'summary_error', title: "Couldn't summarise" }],
      unread: 1,
    })
    await act(async () => { fireEvent.click(screen.getByLabelText('Notifications (1 unread)')) })
    const seen: unknown[] = []
    const onOpen = (e: Event) => seen.push((e as CustomEvent).detail)
    window.addEventListener('app:open-video', onOpen)
    try {
      fireEvent.click(screen.getByText("Couldn't summarise"))
      expect(seen).toEqual([{ videoId: 'abc', panel: undefined }])
    } finally {
      window.removeEventListener('app:open-video', onOpen)
    }
  })

  it('shows the video it is about', async () => {
    await mount({ notifications: [ROW], unread: 1 })
    await act(async () => { fireEvent.click(screen.getByLabelText('Notifications (1 unread)')) })
    const img = document.querySelector('img') as HTMLImageElement
    expect(img.src).toBe('https://i.ytimg.com/vi/abc/mqdefault.jpg')
  })

  it('falls back to the icon when there is no cover to show', async () => {
    await mount({ notifications: [{ ...ROW, thumbnail_url: '' }], unread: 1 })
    await act(async () => { fireEvent.click(screen.getByLabelText('Notifications (1 unread)')) })
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByText('Summary ready')).toBeInTheDocument()
  })

  it('dismisses one row without touching the rest', async () => {
    await mount({
      notifications: [ROW, { ...ROW, id: 2, body: 'Another talk' }],
      unread: 2,
    })
    await act(async () => { fireEvent.click(screen.getByLabelText('Notifications (2 unread)')) })
    await act(async () => { fireEvent.click(screen.getAllByLabelText('Dismiss notification')[0]) })
    expect(screen.queryByText('A talk about pricing')).not.toBeInTheDocument()
    expect(screen.getByText('Another talk')).toBeInTheDocument()
  })
})
