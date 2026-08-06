/**
 * YouTube's scrub-preview sprite sheets.
 *
 * A file on disk gets its scrub frames the direct way — a second, hidden
 * <video> seeked to the hovered time. For a YouTube video the frames aren't
 * ours to seek, so YouTube's own storyboards stand in: a handful of JPEGs, each
 * a grid of thumbnails covering a stretch of the video. `/api/feed/storyboard`
 * hands over the grid dimensions and the sheet URLs; picking a frame is then
 * arithmetic, which is all this file is.
 */

export type StoryboardInfo = {
  rows: number
  cols: number
  frame_width: number
  frame_height: number
  fragment_urls: string[]
  fragment_duration: number
}

export type StoryboardFrame = {
  /** The sheet holding this frame. */
  url: string
  /** background-position, negative — shifts the wanted tile into the window. */
  bgX: number
  bgY: number
  /** The tile's rendered size, i.e. the size of the window onto the sheet. */
  fw: number
  fh: number
  /** background-size: the whole sheet at the same scale. */
  sheetW: number
  sheetH: number
}

/**
 * The frame covering `time`, as the CSS needed to show it.
 *
 * `scale` is the caller's, because the same sheet serves a card thumbnail and a
 * watch-page popup at different sizes. Frame size varies per video, so a caller
 * that wants an exact width should divide by `frame_width` (see `scaleToWidth`).
 */
export function storyboardFrame(sb: StoryboardInfo, time: number, scale: number): StoryboardFrame {
  const framesPerSheet = sb.rows * sb.cols
  const totalFrames = framesPerSheet * sb.fragment_urls.length
  const frameDuration = (sb.fragment_duration * sb.fragment_urls.length) / totalFrames
  const frame = Math.max(0, Math.min(totalFrames - 1, Math.floor(time / frameDuration)))
  const sheetIdx = Math.floor(frame / framesPerSheet)
  const posInSheet = frame % framesPerSheet
  const col = posInSheet % sb.cols
  const row = Math.floor(posInSheet / sb.cols)
  // Rounded, and everything else derived from the rounded values: the tile size
  // and the sheet size have to agree exactly or each tile shows a sliver of its
  // neighbour. (It also keeps `90 * 1.1` out of the CSS as 99.00000000000001.)
  const fw = Math.round(sb.frame_width * scale)
  const fh = Math.round(sb.frame_height * scale)
  return {
    url: sb.fragment_urls[sheetIdx] ?? sb.fragment_urls[0],
    // Guarded so the top-left tile offsets by 0 rather than -0, which would
    // reach the CSS as "-0px".
    bgX: col ? -col * fw : 0,
    bgY: row ? -row * fh : 0,
    fw,
    fh,
    sheetW: sb.cols * fw,
    sheetH: sb.rows * fh,
  }
}

/** The scale that renders a frame exactly `width` px across. */
export function scaleToWidth(sb: StoryboardInfo, width: number): number {
  return sb.frame_width > 0 ? width / sb.frame_width : 0
}
