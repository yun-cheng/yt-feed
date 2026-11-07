import { act, render, screen } from '@testing-library/react'
import { createRef, type RefObject } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../components/ChatReplay'
import DanmakuPhrases from '../components/DanmakuPhrases'
import type { PlayerApi } from '../components/LocalControls'
import { PHRASE_QUIET_SEC, phraseScale } from '../lib/chatPhrases'

const crowd = (sec: number, n: number, text: string, tag: string): ChatMessage[] =>
  Array.from({ length: n }, (_, i) => ({ t: (sec + i) * 1000, a: `@${tag}${i}`, r: [text] }))
const chat = [...crowd(0, 6, 'a', 'x'), ...crowd(0, 9, 'b', 'y')].sort((p, q) => p.t - q.t)

describe('DanmakuPhrases', () => {
  let time = 0
  const player = { current: { getCurrentTime: () => time } } as unknown as RefObject<PlayerApi | null>
  const tick = () => act(() => { vi.advanceTimersByTime(300) })
  const rows = () => [...document.querySelectorAll('.danmaku-phrase')].map((el) => el.textContent)

  beforeEach(() => { time = 0; vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('shows nothing until the chat has caught on', () => {
    render(<DanmakuPhrases player={player} messages={chat} size={1} />)
    expect(screen.queryByTestId('danmaku-phrases')).toBeNull()
  })

  it('counts as the video plays', () => {
    render(<DanmakuPhrases player={player} messages={chat} size={1} />)
    time = 5
    tick()
    expect(rows()).toEqual(['a×6', 'b×6'])
    time = 8
    tick()
    expect(rows()).toEqual(['b×9', 'a×6'])
  })

  it('sizes a row by its count', () => {
    render(<DanmakuPhrases player={player} messages={chat} size={1} />)
    time = 5
    tick()
    const row = () => [...document.querySelectorAll<HTMLElement>('.danmaku-phrase')].find((el) => el.textContent?.startsWith('b'))!
    expect(row().style.fontSize).toBe(`${phraseScale(6)}em`)
    time = 8
    tick()
    expect(row().style.fontSize).toBe(`${phraseScale(9)}em`)
  })

  it('starts the number’s pop only when it goes up', () => {
    render(<DanmakuPhrases player={player} messages={chat} size={1} />)
    time = 5
    tick()
    const count = () => [...document.querySelectorAll('.danmaku-phrase')].find((el) => el.textContent?.startsWith('b'))!.querySelector('.danmaku-phrase-count')
    const was = count()
    time = 5.1
    tick()
    expect(count()).toBe(was)
    time = 6
    tick()
    expect(count()).not.toBe(was)
    expect(count()).toHaveTextContent('×7')
  })

  it('slides rows that change places, and only those', () => {
    const slide = vi.fn()
    const tops = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return { top: [...this.parentElement!.children].indexOf(this) * 40 } as DOMRect
    })
    Element.prototype.animate = slide
    const race = [...crowd(0, 8, 'a', 'x'), ...crowd(0, 6, 'b', 'y'), ...crowd(6, 6, 'b', 'z')].sort((p, q) => p.t - q.t)
    render(<DanmakuPhrases player={player} messages={race} size={1} />)
    time = 5
    tick()
    expect(rows()).toEqual(['a×6', 'b×6'])
    time = 7
    tick()
    expect(rows()).toEqual(['a×8', 'b×8'])
    expect(slide).not.toHaveBeenCalled()
    time = 8
    tick()
    expect(rows()).toEqual(['b×9', 'a×8'])
    expect(slide).toHaveBeenCalledTimes(2)
    expect(slide.mock.calls.map((c) => c[0][0].transform).sort()).toEqual(['translateY(-40px)', 'translateY(40px)'])
    tops.mockRestore()
    delete (Element.prototype as { animate?: unknown }).animate
  })

  it('fades a row out as it goes quiet, then drops it', () => {
    render(<DanmakuPhrases player={player} messages={chat} size={1} />)
    time = 5 + PHRASE_QUIET_SEC - 0.5
    tick()
    const [b, a] = document.querySelectorAll('.danmaku-phrase')
    expect(a).toHaveClass('is-leaving')
    expect(b).not.toHaveClass('is-leaving')
    time = 8 + PHRASE_QUIET_SEC + 1
    tick()
    expect(rows()).toEqual([])
  })

  it('stays solid whatever the 彈幕’s opacity, and keeps clear of the panel', () => {
    time = 5
    render(<DanmakuPhrases player={player} messages={chat} size={1} style={{ right: 320 }} />)
    const layer = screen.getByTestId('danmaku-phrases')
    expect(layer).toHaveStyle({ right: '320px' })
    expect(layer.style.opacity).toBe('')
  })

  it('draws a custom emoji as its picture', () => {
    const wave = { e: 'wave.png', n: ':wave:' }
    const waves = Array.from({ length: 6 }, (_, i) => ({ t: i * 1000, a: `@p${i}`, r: [wave] }))
    time = 5
    render(<DanmakuPhrases player={player} messages={waves} size={1} />)
    expect(document.querySelector('.danmaku-phrase img')).toHaveAttribute('src', 'wave.png')
  })

  it('stops reading the player when it goes', () => {
    const { unmount } = render(<DanmakuPhrases player={createRef() as RefObject<PlayerApi | null>} messages={chat} size={1} />)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
