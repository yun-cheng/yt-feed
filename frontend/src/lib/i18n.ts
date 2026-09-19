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
import { ja } from '../locales/ja'
import { ko } from '../locales/ko'
import { th } from '../locales/th'
import { vi } from '../locales/vi'

export type Lang = 'en' | 'zh-Hant' | 'ja' | 'ko' | 'th' | 'vi'
/** The `app_language` setting: a language, or 'auto' to follow the browser. */
export type LangSetting = Lang | 'auto'

export const LANGS: Lang[] = ['en', 'zh-Hant', 'ja', 'ko', 'th', 'vi']
const TABLES: Record<Lang, Record<string, string>> = { en: {}, 'zh-Hant': zhHant, ja, ko, th, vi }
// The tag Intl and toLocaleString get for each: dates and numbers the way
// they're written where the language is.
const LOCALES: Record<Lang, string> = {
  en: 'en-US', 'zh-Hant': 'zh-TW', ja: 'ja-JP', ko: 'ko-KR', th: 'th-TH', vi: 'vi-VN',
}
const STORAGE_KEY = 'ytfeed:lang'

const isLang = (v: unknown): v is Lang => typeof v === 'string' && (LANGS as string[]).includes(v)

/** 'auto' → whichever language the browser lists first that we have. */
export function resolveLang(setting: unknown, browser: readonly string[] = navigatorLangs()): Lang {
  if (isLang(setting)) return setting
  for (const b of browser) {
    // Any Chinese reads 繁體中文: the only Chinese we have.
    const base = b.toLowerCase().split('-')[0]
    if (base === 'zh') return 'zh-Hant'
    if (isLang(base)) return base
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
    return isLang(v) ? v : null
  } catch { return null }
}

let lang: Lang = stored() ?? resolveLang('auto')
applyToDocument()

function applyToDocument() {
  if (typeof document !== 'undefined') document.documentElement.lang = lang
}

export function getLang(): Lang { return lang }

/** A BCP 47 tag for Intl and toLocaleString. */
export function locale(): string { return LOCALES[lang] }

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
export type TranslateTarget = Lang

let translateSetting: TranslateTarget | '' = ''

/** Install the `translate_lang` setting; '' (or anything unknown) follows the app. */
export function setTranslateSetting(v: unknown) {
  translateSetting = isLang(v) ? v : ''
}

/** What a comment's Translate button translates into. */
export function translateTarget(): TranslateTarget {
  return translateSetting || lang
}

/**
 * Is `text` already in `target`, near enough that offering to translate it
 * would be noise? Judged by script, counting a CJK or Thai character and a run
 * of any other letters (a word) as one unit each, so a Chinese comment about an
 * iPhone is still a Chinese comment: mostly, not entirely. Text with no letters
 * at all (emoji, a bare timestamp) has nothing to translate. Simplified Chinese
 * counts as Chinese: it's readable to someone reading 繁體中文, and telling the
 * two apart would need a dictionary. Japanese shares Chinese's characters, so
 * it also needs some kana to count — kanji alone reads as Chinese.
 *
 * Vietnamese and English share the Latin alphabet; Vietnamese is told apart by
 * the letters only it uses (ơ, ư, đ, ạ, ế…), which turn up in most of its words.
 */
export function looksWrittenIn(text: string, target: TranslateTarget): boolean {
  const units = text.normalize('NFC').match(UNIT) ?? []
  if (!units.length) return true
  const share = (re: RegExp) => units.filter((u) => re.test(u)).length / units.length
  if (target === 'zh-Hant') return share(/\p{Script=Han}/u) >= 0.7
  if (target === 'ko') return share(/^\p{Script=Hangul}+$/u) >= 0.7
  if (target === 'th') return share(/\p{Script=Thai}/u) >= 0.7
  if (target === 'ja') {
    return share(/\p{Script=Hiragana}|\p{Script=Katakana}/u) > 0
      && share(/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u) >= 0.7
  }
  const latin = share(/^\p{Script=Latin}+$/u) >= 0.7
  const vietnamese = share(VIETNAMESE) >= 0.2
  return latin && (target === 'vi' ? vietnamese : !vietnamese)
}

// One CJK or Thai character, or a run of any other letters.
const ONE_CHAR = String.raw`\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Thai}`
const UNIT = new RegExp(String.raw`${ONE_CHAR}|(?:(?!${ONE_CHAR})\p{L})+`, 'gu')
// Letters Vietnamese has and its Latin-alphabet neighbours don't.
const VIETNAMESE = /[đăâêôơưĩũ\u1EA0-\u1EF9]/iu
