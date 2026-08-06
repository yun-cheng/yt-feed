import { describe, it, expect } from 'vitest'
import { storyboardFrame, scaleToWidth } from '../lib/storyboard'
import type { StoryboardInfo } from '../lib/storyboard'

// Two sheets, 5x5 tiles each = 50 frames over 600s, so one frame every 12s.
const SB: StoryboardInfo = {
  rows: 5,
  cols: 5,
  frame_width: 160,
  frame_height: 90,
  fragment_urls: ['https://i.ytimg.com/sb/vid/0.jpg', 'https://i.ytimg.com/sb/vid/1.jpg'],
  fragment_duration: 300,
}

describe('storyboardFrame', () => {
  it('should take the first tile of the first sheet at the start', () => {
    const f = storyboardFrame(SB, 0, 1)
    expect(f.url).toBe(SB.fragment_urls[0])
    expect([f.bgX, f.bgY]).toEqual([0, 0])
  })

  it('should walk across a row before dropping to the next', () => {
    // 30s in = frame 2, so third tile of the top row.
    expect(storyboardFrame(SB, 30, 1)).toMatchObject({ bgX: -320, bgY: 0 })
    // 84s = frame 7, second row, third column.
    expect(storyboardFrame(SB, 84, 1)).toMatchObject({ bgX: -320, bgY: -90 })
  })

  it('should cross into the second sheet once the first is used up', () => {
    // 25 tiles per sheet x 12s = the first sheet covers 0–300s.
    expect(storyboardFrame(SB, 299, 1).url).toBe(SB.fragment_urls[0])
    const f = storyboardFrame(SB, 300, 1)
    expect(f.url).toBe(SB.fragment_urls[1])
    expect([f.bgX, f.bgY]).toEqual([0, 0])
  })

  it('should clamp past either end rather than run off the sheet', () => {
    // A hover can land marginally outside, and a duration that disagrees with
    // the sheet count would otherwise index into nothing.
    expect(storyboardFrame(SB, -10, 1)).toMatchObject({ bgX: 0, bgY: 0 })
    const last = storyboardFrame(SB, 99999, 1)
    expect(last.url).toBe(SB.fragment_urls[1])
    expect([last.bgX, last.bgY]).toEqual([-640, -360])  // bottom-right tile
  })

  it('should scale the tile and the sheet together', () => {
    // The window and the image behind it have to move by the same factor, or
    // the tile shows a seam of its neighbours.
    const f = storyboardFrame(SB, 84, 0.5)
    expect([f.fw, f.fh]).toEqual([80, 45])
    expect([f.sheetW, f.sheetH]).toEqual([400, 225])
    expect([f.bgX, f.bgY]).toEqual([-160, -45])
  })
})

describe('scaleToWidth', () => {
  it('should render a frame exactly the width asked for', () => {
    // What the scrub popup relies on: it asks for its own width and gets it,
    // whatever tile size this particular video's sheets happen to use, so the
    // storyboard preview and the local-file one are the same popup.
    const f = storyboardFrame(SB, 0, scaleToWidth(SB, 240))
    expect(f.fw).toBe(240)
    expect(f.fh).toBe(135)  // the tile's own 16:9 carried through
  })

  it('should survive a sheet that reports no frame size', () => {
    expect(scaleToWidth({ ...SB, frame_width: 0 }, 176)).toBe(0)
  })
})
