import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getLang, setLangSetting } from '../lib/i18n'
import { captionDefaults, setCaptionDefaults } from '../lib/captionDefaults'
import { formatCount } from '../lib/richText'
import { timeAgo } from '../lib/time'
import { rangeLabel } from '../lib/timeWindow'
import TimeSortControls from '../components/TimeSortControls'
import SettingsPage from '../components/SettingsPage'

afterEach(() => { setLangSetting('en'); setCaptionDefaults(undefined); vi.useRealTimers() })

describe('caption defaults', () => {
  it('start on the video’s own track and no second one', () => {
    expect(captionDefaults()).toEqual({ lang: '', lang2: '' })
  })

  it('take the settings as served, and ignore anything that is not a string', () => {
    setCaptionDefaults({ caption_lang: 'ja', caption_lang2: 42 })
    expect(captionDefaults()).toEqual({ lang: 'ja', lang2: '' })
  })
})

describe('in 繁體中文', () => {
  it('counts in 萬 and 億', () => {
    setLangSetting('zh-Hant')
    expect(formatCount(831)).toBe('831')
    expect(formatCount(9_999)).toBe('9999')
    expect(formatCount(355_780)).toBe('35.6萬')
    expect(formatCount(123_000_000)).toBe('1.2億')
  })

  it('counts in each language’s own short forms elsewhere', () => {
    setLangSetting('ja')
    expect(formatCount(355_780)).toBe('35.6万')
    setLangSetting('ko')
    expect(formatCount(355_780)).toBe('35.6만')
    setLangSetting('vi')
    expect(formatCount(12_000_000)).toBe('12\u00a0Tr')
  })

  it('counts in K and M in English', () => {
    expect(formatCount(355_780)).toBe('355.8K')
    expect(formatCount(1_200_000)).toBe('1.2M')
  })

  it('says how long ago', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-20T12:00:00Z'))
    setLangSetting('zh-Hant')
    expect(timeAgo('2026-09-20T11:55:00Z')).toBe('5 分鐘前')
    expect(timeAgo('2026-04-16T12:00:04+00:00')).toBe('5 個月前')
  })

  it('names the time window', () => {
    setLangSetting('zh-Hant')
    expect(rangeLabel({ lo: 0, hi: 2 })).toBe('過去 3 天')
    expect(rangeLabel({ lo: 0, hi: 9 })).toBe('所有時間')
  })

  it('tells a sort order apart from a watch status with the same English', () => {
    setLangSetting('zh-Hant')
    render(<TimeSortControls variant="history" sort="recent" onSortChange={() => {}} />)
    expect(screen.getByRole('button', { name: '觀看時間' })).toBeInTheDocument()
  })
})

describe('the settings page', () => {
  const spec = [
    { key: 'app_language', type: 'choice', label: 'App language', description: 'd', group: 'Language', scope: 'user',
      options: [{ value: 'auto', label: 'Follow the browser' }, { value: 'en', label: 'English' }, { value: 'zh-Hant', label: '繁體中文' }] },
    { key: 'caption_lang', type: 'choice', label: 'Captions open in', description: 'd', group: 'Language', scope: 'user',
      options: [{ value: '', label: "The video's own language" }, { value: 'ja', label: '日本語' }] },
  ]
  const respond = (values: Record<string, unknown>) =>
    ({ ok: true, json: async () => ({ settings: spec, values }) }) as unknown as Response

  // A settings API that keeps what it's sent.
  function serve(values: Record<string, unknown>) {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url) !== '/api/settings') return { ok: false, json: async () => null } as unknown as Response
      if (init?.method === 'PUT') Object.assign(values, JSON.parse(String(init.body)).values)
      return respond({ ...values })
    }))
  }
  afterEach(() => { vi.unstubAllGlobals() })

  it('offers a choice as a menu and saves the pick', async () => {
    serve({ app_language: 'auto', caption_lang: '' })
    render(<SettingsPage />)
    const [, captionMenu] = await screen.findAllByRole('combobox')
    expect(screen.getByRole('option', { name: '日本語' })).toBeInTheDocument()
    fireEvent.change(captionMenu, { target: { value: 'ja' } })
    await waitFor(() => expect(captionDefaults().lang).toBe('ja'))
    expect(getLang()).toBe('en')
  })

  it('switches the app language the moment it is saved', async () => {
    serve({ app_language: 'auto', caption_lang: '' })
    render(<SettingsPage />)
    const [langMenu] = await screen.findAllByRole('combobox')
    fireEvent.change(langMenu, { target: { value: 'zh-Hant' } })
    await waitFor(() => expect(getLang()).toBe('zh-Hant'))
  })
})
