/**
 * The app's own text, in the language you picked.
 *
 * Messages are keyed by their English text — `t('Watch later')` — so the source
 * reads as it always did and English needs no table at all: a string missing
 * from a translation falls back to the English it was written in. `{name}`
 * placeholders are filled from `vars`, in any order the translation needs.
 *
 * A count picks its form with `tn(n, '{n} video', '{n} videos')`. Chinese has
 * one form, so its table maps both English keys to the same text.
 *
 * The language is module state rather than context: `t` is called from plain
 * helpers (timeAgo, sort labels) as well as components. Changing it remounts
 * the app (see DefaultsLoader), which is how every string picks the new one up
 * without each component subscribing. The last language in use is kept in
 * localStorage, so the sign-in screen and the first paint before settings
 * load are already in it.
 */
import { zhHant } from '../locales/zh-Hant'

export type Lang = 'en' | 'zh-Hant'
/** The `app_language` setting: a language, or 'auto' to follow the browser. */
export type LangSetting = Lang | 'auto'

export const LANGS: Lang[] = ['en', 'zh-Hant']
const TABLES: Record<Lang, Record<string, string>> = { en: {}, 'zh-Hant': zhHant }
const STORAGE_KEY = 'ytfeed:lang'

/** 'auto' → whichever language the browser lists first that we have. */
export function resolveLang(setting: unknown, browser: readonly string[] = navigatorLangs()): Lang {
  if (setting === 'en' || setting === 'zh-Hant') return setting
  for (const b of browser) {
    const l = b.toLowerCase()
    if (l.startsWith('zh')) return 'zh-Hant'
    if (l.startsWith('en')) return 'en'
  }
  return 'en'
}

function navigatorLangs(): readonly string[] {
  if (typeof navigator === 'undefined') return []
  return navigator.languages?.length ? navigator.languages : [navigator.language]
}

function stored(): Lang | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return v === 'en' || v === 'zh-Hant' ? v : null
  } catch { return null }
}

let lang: Lang = stored() ?? resolveLang('auto')
applyToDocument()

function applyToDocument() {
  if (typeof document !== 'undefined') document.documentElement.lang = lang === 'zh-Hant' ? 'zh-Hant' : 'en'
}

export function getLang(): Lang { return lang }

/** A BCP 47 tag for Intl and toLocaleString. */
export function locale(): string { return lang === 'zh-Hant' ? 'zh-TW' : 'en-US' }

const listeners = new Set<() => void>()
export function onLangChange(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } }

/** Install the `app_language` setting. Returns whether the language changed. */
export function setLangSetting(setting: unknown): boolean {
  const next = resolveLang(setting)
  try { localStorage.setItem(STORAGE_KEY, next) } catch { /* ignore */ }
  if (next === lang) return false
  lang = next
  applyToDocument()
  listeners.forEach((l) => l())
  return true
}

function fill(s: string, vars?: Record<string, string | number>): string {
  if (!vars) return s
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
}

/** `text` in the current language, with `{name}` placeholders filled. */
export function t(text: string, vars?: Record<string, string | number>): string {
  return fill(TABLES[lang][text] ?? text, vars)
}

/**
 * `text` where the same English means different things in different places —
 * "Watched" is a watch status and, on History, a sort order. Looks up
 * `context|text`, then the English.
 */
export function tc(context: string, text: string, vars?: Record<string, string | number>): string {
  return fill(TABLES[lang][`${context}|${text}`] ?? text, vars)
}

/** The singular or plural message for `n`, with `{n}` filled (plus `vars`). */
export function tn(n: number, one: string, other: string, vars?: Record<string, string | number>): string {
  return t(n === 1 ? one : other, { n, ...vars })
}

/** For tests and the catalogue check. */
export function tableFor(l: Lang): Record<string, string> { return TABLES[l] }

/** A language a comment can be translated into (the `translate_lang` setting). */
export type TranslateTarget = Lang | 'ja' | 'ko'
const TRANSLATE_TARGETS: readonly string[] = ['en', 'zh-Hant', 'ja', 'ko']

let translateSetting: TranslateTarget | '' = ''

/** Install the `translate_lang` setting; '' (or anything unknown) follows the app. */
export function setTranslateSetting(v: unknown) {
  translateSetting = typeof v === 'string' && TRANSLATE_TARGETS.includes(v) ? v as TranslateTarget : ''
}

/** What a comment's Translate button translates into. */
export function translateTarget(): TranslateTarget {
  return translateSetting || lang
}

/**
 * Is `text` already in `target`, near enough that offering to translate it
 * would be noise? Judged by script, counting a CJK character and a run of any
 * other letters (a word) as one unit each, so a Chinese comment about an iPhone
 * is still a Chinese comment: mostly, not entirely. Text with no letters at all
 * (emoji, a bare timestamp) has nothing to translate. Simplified Chinese counts
 * as Chinese: it's readable to someone reading 繁體中文, and telling the two
 * apart would need a dictionary. Japanese shares Chinese's characters, so it
 * also needs some kana to count — kanji alone reads as Chinese.
 */
export function looksWrittenIn(text: string, target: TranslateTarget): boolean {
  const units = text.match(/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|(?:(?!\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana})\p{L})+/gu) ?? []
  if (!units.length) return true
  const share = (re: RegExp) => units.filter((u) => re.test(u)).length / units.length
  if (target === 'zh-Hant') return share(/\p{Script=Han}/u) >= 0.7
  if (target === 'ko') return share(/^\p{Script=Hangul}+$/u) >= 0.7
  if (target === 'ja') {
    return share(/\p{Script=Hiragana}|\p{Script=Katakana}/u) > 0
      && share(/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u) >= 0.7
  }
  return share(/^\p{Script=Latin}+$/u) >= 0.7
}
