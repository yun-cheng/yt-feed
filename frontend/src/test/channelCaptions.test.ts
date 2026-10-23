import { afterEach, describe, expect, it } from 'vitest'
import { CHANNEL_CAPTIONS_KEY, captionMemory, loadChannelCaptions, saveChannelCaptions, setCaptionMemory } from '../lib/channelCaptions'

afterEach(() => {
  localStorage.clear()
  setCaptionMemory(undefined)
})

const twoTracks = { on: true, lang: 'en', lang2: 'ai-zh' }

describe('captions remembered per channel', () => {
  it('remember nothing by default, so every video opens as the last one had them', () => {
    expect(captionMemory()).toBe('last_video')
    saveChannelCaptions('UC1', twoTracks)
    expect(localStorage.getItem(CHANNEL_CAPTIONS_KEY)).toBeNull()
    expect(loadChannelCaptions('UC1')).toBeNull()
  })

  it('read an unknown setting as the default', () => {
    setCaptionMemory('everything')
    expect(captionMemory()).toBe('last_video')
  })

  it('keep on or off for each channel apart', () => {
    setCaptionMemory('channel_on')
    saveChannelCaptions('UC1', twoTracks)
    saveChannelCaptions('UC2', { on: false, lang: '', lang2: '' })
    expect(loadChannelCaptions('UC1')).toEqual({ on: true })
    expect(loadChannelCaptions('UC2')).toEqual({ on: false })
    expect(loadChannelCaptions('UC3')).toBeNull()
  })

  it('keep the tracks too when asked, the AI translation among them', () => {
    setCaptionMemory('channel_tracks')
    saveChannelCaptions('UC1', twoTracks)
    expect(loadChannelCaptions('UC1')).toEqual(twoTracks)
  })

  it('leave tracks kept earlier in place under on/off only, and find them again', () => {
    setCaptionMemory('channel_tracks')
    saveChannelCaptions('UC1', twoTracks)
    setCaptionMemory('channel_on')
    saveChannelCaptions('UC1', { on: false, lang: 'ja', lang2: '' })
    expect(loadChannelCaptions('UC1')).toEqual({ on: false })
    setCaptionMemory('channel_tracks')
    expect(loadChannelCaptions('UC1')).toEqual({ ...twoTracks, on: false })
  })

  it('give a channel remembered only as on or off no tracks, so the defaults pick them', () => {
    setCaptionMemory('channel_on')
    saveChannelCaptions('UC1', twoTracks)
    setCaptionMemory('channel_tracks')
    expect(loadChannelCaptions('UC1')).toEqual({ on: true })
  })

  it('survive a store that no longer parses', () => {
    setCaptionMemory('channel_on')
    localStorage.setItem(CHANNEL_CAPTIONS_KEY, '{oops')
    expect(loadChannelCaptions('UC1')).toBeNull()
    saveChannelCaptions('UC1', twoTracks)
    expect(loadChannelCaptions('UC1')).toEqual({ on: true })
  })
})
