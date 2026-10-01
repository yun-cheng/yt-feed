/**
 * Where a small menu opens: under its button by default. It goes above the
 * button when there's more room there, slides sideways rather than off the
 * screen's edge, and scrolls rather than running past the top or bottom.
 *
 * Floating UI does the measuring and keeps it current as the page scrolls or
 * the menu changes size. The card's ⋮ menu is the case that needs that: it
 * swaps its items for the longer playlist list in place, and that list loads
 * after it opens.
 *
 * Rendered into document.body (`inPortal`). Inside the page, an ancestor's
 * stacking context caps any z-index the menu has. The watch page's action
 * stack is z-20, so the player's control bar (z-30) drew its progress bar over
 * a Save menu that opened upward. At the top level, `MENU_LAYER` puts it over
 * the watch overlay (z-60) and under the dialogs (z-70).
 *
 * Portalled, the menu is no longer inside its button's wrapper. An
 * outside-click check has to ask `contains` as well, or a click on the menu
 * reads as a click outside it. React events still bubble through the portal
 * to the component tree, so a menu's `stopPropagation` keeps working as before.
 */
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { autoUpdate, flip, offset, shift, size, useFloating, type Placement } from '@floating-ui/react-dom'

/** The menu's z-index class, at the top level of the page. */
export const MENU_LAYER = 'z-[65]'

/** The menu, rendered at the top level of the page. */
export function inPortal(menu: ReactNode) {
  return createPortal(menu, document.body)
}

/** Kept clear of the window's edge, so a menu never sits flush against it. */
const EDGE = 8

export function usePopover({ placement = 'bottom-end', gap = 8 }: { placement?: Placement; gap?: number } = {}) {
  const { refs, floatingStyles } = useFloating({
    placement,
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(gap),
      flip({ padding: EDGE }),
      shift({ padding: EDGE }),
      // When neither side fits the whole menu, it gets the larger one and
      // scrolls. Its class needs `overflow-y-auto`.
      size({
        padding: EDGE,
        apply({ availableHeight, elements }) {
          elements.floating.style.maxHeight = `${Math.max(0, availableHeight)}px`
        },
      }),
    ],
  })
  return {
    anchorRef: refs.setReference,
    menuRef: refs.setFloating,
    menuStyle: floatingStyles,
    /** Whether a node is inside the menu. For a check that closes it on a
     *  click outside. */
    contains: (node: Node | null) => !!node && !!refs.floating.current?.contains(node),
  }
}
