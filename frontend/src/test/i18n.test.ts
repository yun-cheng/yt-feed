import { afterEach, describe, expect, it } from 'vitest'
import { resolveLang, setLangSetting, t, tableFor, tn, getLang } from '../lib/i18n'

afterEach(() => { setLangSetting('en') })

describe('resolveLang', () => {
  it('takes an explicit language as it is', () => {
    expect(resolveLang('zh-Hant', ['en-US'])).toBe('zh-Hant')
    expect(resolveLang('en', ['zh-TW'])).toBe('en')
  })

  it('follows the first browser language it has', () => {
    expect(resolveLang('auto', ['zh-TW', 'en'])).toBe('zh-Hant')
    expect(resolveLang('auto', ['zh-CN'])).toBe('zh-Hant')
    expect(resolveLang('auto', ['fr', 'en-GB'])).toBe('en')
    expect(resolveLang('auto', ['fr'])).toBe('en')
    expect(resolveLang(undefined, [])).toBe('en')
  })
})

describe('t', () => {
  it('is the English it was given, filled in, when the language is English', () => {
    expect(t('Watch later')).toBe('Watch later')
    expect(t('{n} left', { n: 3 })).toBe('3 left')
  })

  it('translates, and falls back to the English for a missing entry', () => {
    setLangSetting('zh-Hant')
    expect(getLang()).toBe('zh-Hant')
    expect(t('Settings')).toBe(tableFor('zh-Hant')['Settings'])
    expect(t('no such message {x}', { x: 1 })).toBe('no such message 1')
  })

  it('picks the plural form by count', () => {
    expect(tn(1, '{n} video', '{n} videos')).toBe('1 video')
    expect(tn(2, '{n} video', '{n} videos')).toBe('2 videos')
  })

  it('reports whether the language changed', () => {
    expect(setLangSetting('en')).toBe(false)
    expect(setLangSetting('zh-Hant')).toBe(true)
  })
})

// Every literal message in the source, as `t('…')` / `tn(n, '…', '…')` write it.
// Comments are stripped first: the docs show calls that aren't messages.
const SOURCES = import.meta.glob(['../**/*.{ts,tsx}', '!../test/**', '!../locales/**'], {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>

function sourceMessages(): Set<string> {
  const lit = String.raw`'((?:[^'\\]|\\.)*)'`
  const one = new RegExp(String.raw`\bt\(\s*` + lit, 'g')
  const plural = new RegExp(String.raw`\btn\([^,]+,\s*` + lit + String.raw`\s*,\s*` + lit, 'g')
  const out = new Set<string>()
  const unescape = (s: string) => s.replace(/\\(.)/g, '$1')
  for (const raw of Object.values(SOURCES)) {
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    for (const m of src.matchAll(one)) out.add(unescape(m[1]))
    for (const m of src.matchAll(plural)) { out.add(unescape(m[1])); out.add(unescape(m[2])) }
  }
  return out
}

describe('the 繁體中文 catalogue', () => {
  const used = sourceMessages()
  const table = tableFor('zh-Hant')

  it('has every message the source asks for', () => {
    expect(used.size).toBeGreaterThan(0)
    expect([...used, ...EXTRA].filter((m) => !(m in table))).toEqual([])
  })

  it('has nothing the source no longer asks for', () => {
    // Messages that reach t() through a variable (settings specs, sort names)
    // are listed in EXTRA_KEYS by the module that owns them.
    expect(Object.keys(table).filter((m) => !used.has(m) && !EXTRA.has(m))).toEqual([])
  })

  it('keeps every placeholder its English has', () => {
    const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
    const bad = Object.entries(table).filter(([en, zh]) => holes(en).join() !== holes(zh).join())
    expect(bad).toEqual([])
  })
})

import { DYNAMIC_MESSAGES } from '../locales/dynamic'
const EXTRA = new Set(DYNAMIC_MESSAGES)

import { looksWrittenIn, setTranslateSetting, translateTarget } from '../lib/i18n'

describe('looksWrittenIn', () => {
  it('reads English as English, and Chinese with a brand name in it as Chinese', () => {
    expect(looksWrittenIn('great video, thanks!', 'en')).toBe(true)
    expect(looksWrittenIn('這支 iPhone 真的很好用', 'zh-Hant')).toBe(true)
    expect(looksWrittenIn('这个视频太好了', 'zh-Hant')).toBe(true)
  })

  it('reads another language as one to translate', () => {
    expect(looksWrittenIn('這部影片太好看了', 'en')).toBe(false)
    expect(looksWrittenIn('great video', 'zh-Hant')).toBe(false)
    expect(looksWrittenIn('とても良い動画です', 'zh-Hant')).toBe(false)
    expect(looksWrittenIn('très bonne vidéo', 'en')).toBe(true)
  })

  it('has nothing to translate without letters', () => {
    expect(looksWrittenIn('😂😂 1:23', 'en')).toBe(true)
  })
})

describe('looksWrittenIn, for Japanese and Korean', () => {
  it('needs kana to call something Japanese', () => {
    expect(looksWrittenIn('とても良い動画です', 'ja')).toBe(true)
    expect(looksWrittenIn('這部影片太好看了', 'ja')).toBe(false)
    expect(looksWrittenIn('great video', 'ja')).toBe(false)
  })

  it('reads Hangul as Korean', () => {
    expect(looksWrittenIn('정말 좋은 영상이에요', 'ko')).toBe(true)
    expect(looksWrittenIn('great video', 'ko')).toBe(false)
  })
})

describe('the translate target', () => {
  afterEach(() => { setTranslateSetting('') })

  it('follows the app language until one is set', () => {
    expect(translateTarget()).toBe('en')
    setLangSetting('zh-Hant')
    expect(translateTarget()).toBe('zh-Hant')
  })

  it('is the setting once there is one, and ignores what it does not know', () => {
    setTranslateSetting('ja')
    expect(translateTarget()).toBe('ja')
    setTranslateSetting('fr')
    expect(translateTarget()).toBe('en')
  })
})
