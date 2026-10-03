/**
 * The panel laid over the video — Info, Chapters, Bookmarks, Repeat, Notes,
 * Comments, Transcript and Ask AI in a column down one side of the picture, to
 * read while it plays without leaving it for the details below. Opened with `g` or the
 * button beside CC, on the tab the `video_panel_tab` setting names
 * (lib/videoPanel.ts).
 *
 * This is the frame: the tabs, the side it sits on, and the way out. What each
 * tab shows is the watch page's, passed in as `children` — the same data the
 * details below it draw from, so opening a tab here after its twin there
 * fetches nothing twice.
 *
 * Narrow on purpose: it takes a column of the frame rather than a side of it,
 * so most of the video stays in view, and the captions keep clear of it (see
 * CaptionRow in WatchPage). A backdrop rather than a panel: dark enough for the text,
 * see-through enough that it still reads as part of the player. Flush with the
 * player's top and side edges, reaching down as far as the page says — it knows
 * where the progress bar is and whether it's showing.
 */
import type { CSSProperties, ReactNode } from 'react'
import type { PanelTabKey } from '../lib/videoPanel'
import { t } from '../lib/i18n'

type Props = {
  /** Closed, it stays mounted but hidden, so its tabs keep their state. */
  open: boolean
  tabs: { key: PanelTabKey; label: string; icon: ReactNode }[]
  tab: PanelTabKey
  onTab: (tab: PanelTabKey) => void
  side: 'left' | 'right'
  onSwapSide: () => void
  onClose: () => void
  /** A CSS width. The page moves the captions aside by the same amount. */
  width: string
  /** How far above the player's bottom edge the column stops. */
  bottom: string
  /** The tabs' content, each in a PanelTab. Each owns its own scrolling: a
   *  transcript follows the play head and Ask keeps its box at the foot, so one
   *  scroller can't fit all. */
  children: ReactNode
}

/** The panel's own rem: 14px over a 1024px-wide player, growing and shrinking
 *  with the player the way the captions do (they're 2.5cqw), so fullscreen
 *  reads as well as the page does. The floor keeps a small player legible.
 *
 *  Everything in the panel hangs off it — type, spacing, icons, avatars, the
 *  header, and its narrowest (PANEL_WIDTH in WatchPage) — so it's the same panel at any size,
 *  scaled, rather than bigger letters squeezed into the same column. That
 *  works because Tailwind's `text-xs` / `p-3` / `h-7` read theme variables
 *  (`--text-xs`, `--spacing`), which `.panel-type` in index.css redefines in
 *  terms of this. cqw here is a share of the player box: it's the size
 *  container, and the nearest one to every use below. */
export const PANEL_UNIT = 'max(12px, 1.375cqw)'

const HEADER_BUTTON = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-shade-cc transition-colors hover:bg-white/10 hover:text-white'

export default function VideoPanel({ open, tabs, tab, onTab, side, onSwapSide, onClose, width, bottom, children }: Props) {
  const other = side === 'right' ? t('Move to the left') : t('Move to the right')
  return (
    <div
      // Rounded only where its foot stops short of the player's edge.
      className={`absolute top-0 ${side === 'right' ? 'right-0' : 'left-0'} ${
        bottom === '0px' ? '' : side === 'right' ? 'rounded-bl-xl' : 'rounded-br-xl'
      } z-20 flex flex-col overflow-hidden bg-black/65 text-white shadow-lg backdrop-blur-sm transition-[bottom] duration-200 panel-type`}
      // Hidden by visibility rather than display: a box taken out of layout can
      // come back scrolled to the top, which is the state this keeps.
      style={{ width, bottom, visibility: open ? undefined : 'hidden', '--panel-unit': PANEL_UNIT } as CSSProperties}
      aria-hidden={!open}
      role="complementary"
      aria-label={t('Panel on the video')}
    >
      {/* Wraps rather than squeezes: at its narrowest the tabs drop to a line
          of their own. */}
      <div className="flex shrink-0 flex-wrap items-center gap-1 py-1.5 pl-2 pr-1">
        <div role="tablist" className="mr-auto flex rounded-full bg-white/10 p-0.5">
          {tabs.map(({ key, label, icon }) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              aria-label={label}
              title={label}
              onClick={() => onTab(key)}
              className={`flex h-7 w-8 items-center justify-center rounded-full transition-colors ${
                tab === key ? 'bg-white text-black' : 'text-shade-cc hover:text-white'
              }`}
            >
              {icon}
            </button>
          ))}
        </div>
        <button onClick={onSwapSide} className={HEADER_BUTTON} title={other} aria-label={other}>
          {/* Two arrows, left and right: it goes to the other side. */}
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 8h15m0 0-3.5-3.5M19 8l-3.5 3.5M20 16H5m0 0 3.5-3.5M5 16l3.5 3.5" />
          </svg>
        </button>
        <button onClick={onClose} className={HEADER_BUTTON} title={t('Hide the panel')} aria-label={t('Hide the panel')}>
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
            <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      <div className="relative min-h-0 flex-1">{children}</div>
    </div>
  )
}

/** A tab body that is just something to read: one scroller, and reaching its
 *  end doesn't carry on into scrolling the page under the player. `padded`
 *  off for content that brings its own side padding, like the comments. */
export function PanelScroll({ children, padded = true }: { children: ReactNode; padded?: boolean }) {
  return (
    <div className={`min-h-0 flex-1 overflow-y-auto overscroll-contain pb-3 pt-1 ${padded ? 'px-3' : ''}`}>
      {children}
    </div>
  )
}

/** One tab's content, stacked with the others'. The tabs you've opened stay
 *  mounted and only the shown one is visible — by visibility, not display, so
 *  a hidden tab keeps its scroll position as well as its state. */
export function PanelTab({ shown, children }: { shown: boolean; children: ReactNode }) {
  return (
    <div
      className="absolute inset-0 flex flex-col"
      style={shown ? undefined : { visibility: 'hidden' }}
      aria-hidden={!shown}
    >
      {children}
    </div>
  )
}
