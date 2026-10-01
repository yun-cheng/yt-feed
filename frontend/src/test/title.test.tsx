import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { TITLE_RANK, useDocumentTitle } from '../lib/title'

function Claim({ title, rank }: { title: string | null; rank: number }) {
  useDocumentTitle(title, rank)
  return null
}

describe('the tab title', () => {
  it('goes back to the app alone when the last name leaves', () => {
    const { unmount } = render(<Claim title="Settings" rank={TITLE_RANK.page} />)
    expect(document.title).toBe('Settings - My Feed')
    unmount()
    expect(document.title).toBe('My Feed')
  })

  it('names the page, then the video opened over it, then the page again once it closes', () => {
    const { rerender } = render(<>
      <Claim title="History" rank={TITLE_RANK.page} />
    </>)
    expect(document.title).toBe('History - My Feed')

    rerender(<>
      <Claim title="History" rank={TITLE_RANK.page} />
      <Claim title="A video" rank={TITLE_RANK.video} />
    </>)
    expect(document.title).toBe('A video - My Feed')

    rerender(<>
      <Claim title="History" rank={TITLE_RANK.page} />
    </>)
    expect(document.title).toBe('History - My Feed')
  })

  it('keeps the video when the page under it renames itself', () => {
    const { rerender } = render(<>
      <Claim title="A channel" rank={TITLE_RANK.item} />
      <Claim title="A video" rank={TITLE_RANK.video} />
    </>)
    rerender(<>
      <Claim title="Another channel" rank={TITLE_RANK.item} />
      <Claim title="A video" rank={TITLE_RANK.video} />
    </>)
    expect(document.title).toBe('A video - My Feed')
  })

  it('leaves a name still loading to the rank below', () => {
    render(<>
      <Claim title="Playlists" rank={TITLE_RANK.page} />
      <Claim title="" rank={TITLE_RANK.item} />
    </>)
    expect(document.title).toBe('Playlists - My Feed')
  })
})
