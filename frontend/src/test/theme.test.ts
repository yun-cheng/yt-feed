/**
 * The light theme works by every color being a variable (see the Themes block
 * in index.css), so the ways to break it are writing a color that isn't one, and
 * naming a token that doesn't exist — which Tailwind answers with no rule at
 * all, rather than an error. Both are read off the source, like
 * touchReveal.test.ts does.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { getThemeSetting, resolveTheme, setThemeSetting } from '../lib/theme'
import css from '../index.css?raw'
import html from '../../index.html?raw'

const SOURCES = {
  ...import.meta.glob(['../**/*.tsx', '../**/*.ts', '!../test/**', '!../locales/**'], {
    query: '?raw', import: 'default', eager: true,
  }) as Record<string, string>,
  'index.html': html,
}

afterEach(() => setThemeSetting('dark'))

describe('the theme setting', () => {
  it('starts dark', () => {
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('puts the chosen theme on <html>, and keeps it for the next first paint', () => {
    setThemeSetting('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(localStorage.getItem('ytfeed:theme')).toBe('light')
  })

  it('follows the device when set to match the system', () => {
    expect(resolveTheme('system', true)).toBe('light')
    expect(resolveTheme('system', false)).toBe('dark')
  })

  it('reads anything it does not know as dark', () => {
    setThemeSetting('sepia')
    expect(getThemeSetting()).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
})

describe('every color in a class follows the theme', () => {
  it('names a token rather than a hex value', () => {
    const hex = Object.entries(SOURCES).flatMap(([path, source]) =>
      (source.match(/[\w:-]+-\[#[0-9a-fA-F]{3,8}\][\w/]*/g) ?? []).map((m) => `${path}: ${m}`))
    expect(hex).toEqual([])
  })

  it('names only tokens that index.css defines, in both themes', () => {
    const used = new Set(Object.values(SOURCES).flatMap((source) =>
      [...source.matchAll(/-((?:shade|tint)-[0-9a-f]+)\b/g)].map((m) => m[1])))
    expect(used.size).toBeGreaterThan(20)
    const block = (selector: string) => css.slice(css.indexOf(selector)).split('}')[0]
    const dark = block(':root,\n[data-theme="dark"] {')
    const light = block('[data-theme="light"] {')
    const missing = [...used].filter((name) =>
      !css.includes(`--color-${name}: var(--${name});`) || !dark.includes(`--${name}:`) || !light.includes(`--${name}:`))
    expect(missing).toEqual([])
  })
})
