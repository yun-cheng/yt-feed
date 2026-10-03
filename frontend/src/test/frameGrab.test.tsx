import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFileFrames } from '../lib/frameGrab'

// jsdom decodes no video, so the <video> and <canvas> the grabber makes are
// stand-ins: the video "loads" as soon as it has a src and "seeks" wherever
// it's told, and the canvas hands back an empty JPEG.
let seeks: number[]
let blobs: number

beforeEach(() => {
  seeks = []
  blobs = 0
  const create = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag === 'video') {
      const v = new EventTarget() as EventTarget & Record<string, unknown>
      let time = 0
      Object.assign(v, {
        muted: false, preload: '', duration: 100, videoWidth: 320, videoHeight: 180,
        removeAttribute: () => {}, load: () => {},
      })
      Object.defineProperty(v, 'src', { set: () => { setTimeout(() => v.dispatchEvent(new Event('loadeddata'))) } })
      Object.defineProperty(v, 'currentTime', {
        get: () => time,
        set: (t: number) => { time = t; seeks.push(t); setTimeout(() => v.dispatchEvent(new Event('seeked'))) },
      })
      return v
    }
    if (tag === 'canvas') {
      return {
        width: 0, height: 0,
        getContext: () => ({ drawImage: () => {} }),
        toBlob: (cb: (b: Blob) => void) => cb(new Blob()),
      }
    }
    return create(tag)
  }) as typeof document.createElement)
  URL.createObjectURL = vi.fn(() => `blob:${++blobs}`)
  URL.revokeObjectURL = vi.fn()
})

afterEach(() => { vi.restoreAllMocks() })

describe('useFileFrames', () => {
  it('grabs each moment from the file, one after another', async () => {
    const { result } = renderHook(() => useFileFrames('/f/a', [10, 20]))
    await waitFor(() => expect(result.current(20)).toBeDefined())
    expect(result.current(10)).toBeDefined()
    expect(seeks).toEqual([10, 20])
  })

  it('keeps what it grabbed: asking again seeks nothing', async () => {
    const first = renderHook(() => useFileFrames('/f/b', [5]))
    await waitFor(() => expect(first.result.current(5)).toBeDefined())
    first.unmount()
    seeks = []
    const again = renderHook(() => useFileFrames('/f/b', [5]))
    expect(again.result.current(5)).toBe(first.result.current(5))
    expect(seeks).toEqual([])
  })

  it('stops short of the end, where a seek can land past the last frame', async () => {
    const { result } = renderHook(() => useFileFrames('/f/c', [100]))
    await waitFor(() => expect(result.current(100)).toBeDefined())
    expect(seeks[0]).toBeCloseTo(99.9)
  })

  it('grabs nothing without a file, or without moments', () => {
    renderHook(() => useFileFrames(null, [10]))
    renderHook(() => useFileFrames('/f/d', []))
    expect(document.createElement).not.toHaveBeenCalledWith('video')
  })
})
