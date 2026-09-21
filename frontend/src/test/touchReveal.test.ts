/**
 * A control that only appears on hover doesn't exist on a phone.
 *
 * Tailwind gates `hover:` — and therefore `group-hover:` — behind
 * `@media (hover: hover)`, so `opacity-0 group-hover:opacity-100` resolves to a
 * permanently invisible control wherever there is no pointer. The fix is to
 * hide it only where hovering can bring it back: `hoverable:opacity-0` (the
 * variant is declared in index.css).
 *
 * This reads the components rather than rendering them, because what's wrong
 * with the old pattern can't be observed in jsdom: both rules are present in
 * the DOM either way, and which one wins is decided by a media query no test
 * environment evaluates. So the rule is enforced where it's written — through
 * Vite's own `?raw` imports, which need no Node types.
 */
import { describe, expect, it } from 'vitest'

const SOURCES = import.meta.glob('../components/*.tsx', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>

/**
 * Reveals that are allowed to stay pointer-only, because they live INSIDE
 * something that is itself hover-only: the card's hover preview (its volume
 * slider and its scrubber knob) and the watch page's up-next peek. A phone
 * never opens the thing these sit in, so making them visible would only mean
 * making them visible to nobody.
 */
const HOVER_ONLY_SURFACES: Record<string, number> = {
  'VideoCard.tsx': 2,
  'WatchPage.tsx': 1,
}

/** Every `className` string in a file, one per match. */
function classNames(source: string): string[] {
  return source.match(/class(?:Name)?=(?:"[^"]*"|`[^`]*`|\{`[^`]*`\})/g) ?? []
}

const files = Object.entries(SOURCES).map(
  ([path, source]) => [path.split('/').pop() as string, source] as const,
)

describe('controls that appear on hover', () => {
  it('reads every component', () => {
    expect(files.length).toBeGreaterThan(30)
  })

  it.each(files)('%s hides them only where there is a pointer', (file, source) => {
    const offenders = classNames(source).filter(
      (cls) => /(?:^|[\s`"{])opacity-0[\s`"]/.test(cls) && /group-hover(?:\/[\w-]+)?:opacity-100/.test(cls),
    )
    expect(offenders).toHaveLength(HOVER_ONLY_SURFACES[file] ?? 0)
  })

  it('never lets a reveal lose to the rule that hides it', () => {
    // `hoverable:` is a custom variant, so Tailwind emits it AFTER the built-in
    // ones. An unprefixed `group-hover:opacity-100` beside `hoverable:opacity-0`
    // therefore comes earlier in the sheet and loses at equal specificity — the
    // control would be hidden on a desktop too. Both halves, or neither.
    const broken: string[] = []
    for (const [file, source] of files) {
      for (const cls of classNames(source)) {
        if (!cls.includes('hoverable:')) continue
        const bare = cls.match(/(?:^|[\s`"{])(?:group-hover(?:\/[\w-]+)?|focus):(?:opacity-100|w-16)/g)
        if (bare) broken.push(`${file}: ${bare.join(', ')}`)
      }
    }
    expect(broken).toEqual([])
  })
})
