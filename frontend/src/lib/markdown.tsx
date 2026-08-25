/**
 * The small slice of Markdown a model actually writes, rendered.
 *
 * Hand-rolled rather than a dependency, for one reason that outweighs the rest:
 * the leaves have to go through `linkify`, so a timestamp inside a bullet is
 * still a button that seeks the player. Any library would need a custom text
 * renderer wired in to manage that — at which point the parse is the only part
 * being borrowed, and the parse is the easy half.
 *
 * What's covered is what LLM answers contain: headings, bullet and numbered
 * lists (one level of nesting), bold, italic, inline code, and paragraphs.
 * Anything else falls through as text, which is the right failure: an unhandled
 * construct reads as slightly ugly prose rather than disappearing.
 */
import type { ReactNode } from 'react'
import { linkify } from './richText'

type Item = { text: string; children: string[] }
type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: Item[] }
  | { kind: 'para'; text: string }

const HEADING = /^(#{1,6})\s+(.*)$/
const BULLET = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
// Code first, so `**` inside a code span isn't read as bold. Bold before
// italic, so `**x**` isn't seen as an empty italic wrapping `*x*`.
const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\s][^*]*\*)|(_[^_\s][^_]*_)/g

/** Split source text into the blocks above. */
export function parseBlocks(src: string): Block[] {
  const blocks: Block[] = []
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  let para: string[] = []

  const flushPara = () => {
    const text = para.join(' ').trim()
    para = []
    if (text) blocks.push({ kind: 'para', text })
  }

  for (const line of lines) {
    if (!line.trim()) { flushPara(); continue }

    const h = HEADING.exec(line)
    if (h) {
      flushPara()
      blocks.push({ kind: 'heading', level: h[1].length, text: h[2].trim() })
      continue
    }

    const b = BULLET.exec(line)
    if (b) {
      flushPara()
      const [, indent, marker, text] = b
      const ordered = /\d/.test(marker)
      const last = blocks[blocks.length - 1]
      const open = last && last.kind === 'list' && last.ordered === ordered ? last : null
      // Indented under something: a sub-item of the bullet above it. Only one
      // level deep — past that the model is writing an outline, not an answer,
      // and flattening reads better than nesting forever.
      if (indent.length >= 2 && open?.items.length) {
        open.items[open.items.length - 1].children.push(text)
      } else if (open) {
        open.items.push({ text, children: [] })
      } else {
        blocks.push({ kind: 'list', ordered, items: [{ text, children: [] }] })
      }
      continue
    }

    para.push(line.trim())
  }
  flushPara()
  return blocks
}

/** Bold / italic / code, with everything else handed to `linkify`. */
function inline(text: string, key: string, onSeek: (s: number) => void): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  INLINE.lastIndex = 0
  while ((m = INLINE.exec(text)) !== null) {
    if (m.index > last) out.push(...linkify(text.slice(last, m.index), onSeek))
    const [full] = m
    const k = `${key}-${m.index}`
    if (full.startsWith('`')) {
      out.push(
        <code key={k} className="rounded bg-white/10 px-1 py-0.5 font-mono text-[0.85em]">
          {full.slice(1, -1)}
        </code>
      )
    } else if (full.startsWith('**') || full.startsWith('__')) {
      out.push(<strong key={k} className="font-semibold text-white">{linkify(full.slice(2, -2), onSeek)}</strong>)
    } else {
      out.push(<em key={k}>{linkify(full.slice(1, -1), onSeek)}</em>)
    }
    last = m.index + full.length
  }
  if (last < text.length) out.push(...linkify(text.slice(last), onSeek))
  return out
}

/** Markdown as React, with timestamps live throughout. */
export function renderMarkdown(src: string, onSeek: (s: number) => void): ReactNode {
  return parseBlocks(src).map((b, i) => {
    if (b.kind === 'heading') {
      // One rendered size for every level: these sit in a narrow side panel, and
      // an h2/h3 distinction the model chose at random would only add noise.
      return (
        <p key={i} className="mt-3 font-semibold text-white first:mt-0">
          {inline(b.text, `h${i}`, onSeek)}
        </p>
      )
    }
    if (b.kind === 'para') {
      return <p key={i} className="mt-2 first:mt-0">{inline(b.text, `p${i}`, onSeek)}</p>
    }
    const List = b.ordered ? 'ol' : 'ul'
    return (
      <List
        key={i}
        className={`mt-2 space-y-1 pl-5 first:mt-0 ${b.ordered ? 'list-decimal' : 'list-disc'}`}
      >
        {b.items.map((it, j) => (
          <li key={j} className="marker:text-[#666]">
            {inline(it.text, `l${i}-${j}`, onSeek)}
            {!!it.children.length && (
              <ul className="mt-1 space-y-1 pl-4 list-disc">
                {it.children.map((c, k) => (
                  <li key={k} className="marker:text-[#666]">{inline(c, `l${i}-${j}-${k}`, onSeek)}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </List>
    )
  })
}
