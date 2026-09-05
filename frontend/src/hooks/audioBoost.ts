/**
 * PER-VIDEO amplification, past the point the volume slider can reach.
 *
 * The shared volume (see audioStore) is one level for everything you watch, and
 * it stops at 100% — the loudest the file itself is. Some videos are simply
 * mixed quiet, and turning the shared volume up to compensate makes the NEXT
 * video shout. So this is the other half of the pair: a gain that belongs to the
 * video you're on, resets when you leave it, and multiplies whatever the shared
 * slider is doing (final loudness = the element's volume × this).
 *
 * It needs the audio itself, which means it only works on media WE serve — a
 * downloaded file or one from a local folder. The YouTube embed is a
 * cross-origin iframe: its audio is not ours to route, and nothing in the IFrame
 * API amplifies, so there is no boost there to offer.
 *
 * The graph is built LAZILY, on the first boost above 1×, for two reasons that
 * both matter: `createMediaElementSource` is a one-way door (from then on the
 * element's audio reaches the speakers only through our graph, so a suspended
 * context would mean silence), and that first raise is a click — the user
 * gesture that lets the context start. Left alone, the ordinary path never
 * touches WebAudio at all.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

/** As loud as the boost goes. Plain gain runs out of headroom well before this —
 *  which is why the chain ends in a limiter (below) rather than stopping at the
 *  point where peaks start to clip. */
export const MAX_BOOST = 8
/** The grain of the boost slider, in multiples. */
export const BOOST_STEP = 0.25

type Ctor = typeof AudioContext

function audioCtor(): Ctor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor }
  return w.AudioContext ?? w.webkitAudioContext ?? null
}

/** Whether this browser can amplify at all — checked before the control is
 *  offered, so a browser without WebAudio simply doesn't show one. */
export function boostSupported(): boolean {
  return audioCtor() !== null
}

type Graph = { ctx: AudioContext; gain: GainNode }

/** A limiter to sit after the gain.
 *
 *  Multiplying a track that's already near full scale doesn't make the loud
 *  parts louder, it makes them clip — so past about 4× straight gain buys
 *  distortion rather than volume. Holding the peaks down is what lets the rest
 *  of the range be worth having: quiet dialogue keeps climbing while the peaks
 *  stop where they are. A fast attack and a soft knee, so speech doesn't pump. */
function limiter(ctx: AudioContext): DynamicsCompressorNode {
  const c = ctx.createDynamicsCompressor()
  c.threshold.value = -6
  c.knee.value = 6
  c.ratio.value = 12
  c.attack.value = 0.003
  c.release.value = 0.25
  return c
}

/**
 * The boost for the element in `elRef`, reset whenever `resetKey` changes —
 * pass the video's id or src, so moving to another video starts it at normal
 * loudness again.
 */
export function useBoost(elRef: RefObject<HTMLMediaElement | null>, resetKey?: string) {
  const [boost, setBoost] = useState(1)
  const graphRef = useRef<Graph | null>(null)

  // A different video is a different mix: it gets its own judgement, not the
  // one that fixed the last one.
  useEffect(() => { setBoost(1) }, [resetKey])

  // Follow the state whenever a graph exists. At 1× with no graph there is
  // nothing to follow — which is the whole point of building it lazily.
  useEffect(() => {
    const g = graphRef.current
    if (g) g.gain.gain.value = boost
  }, [boost])

  // The context can be suspended out from under us (a background tab, a
  // policy). With the audio routed through it, that's silence rather than a
  // pause, so every play is a chance to make sure it's running.
  useEffect(() => {
    const el = elRef.current
    if (!el) return
    const resume = () => { void graphRef.current?.ctx.resume().catch(() => { /* nothing to do */ }) }
    el.addEventListener('play', resume)
    return () => el.removeEventListener('play', resume)
  }, [elRef])

  useEffect(() => () => { void graphRef.current?.ctx.close().catch(() => { /* already gone */ }) }, [])

  const apply = useCallback((next: number) => {
    const v = Math.max(1, Math.min(MAX_BOOST, next))
    const el = elRef.current
    if (!graphRef.current && el && v !== 1) {
      const Ctor = audioCtor()
      if (Ctor) {
        try {
          const ctx = new Ctor()
          const gain = ctx.createGain()
          ctx.createMediaElementSource(el).connect(gain).connect(limiter(ctx)).connect(ctx.destination)
          graphRef.current = { ctx, gain }
        } catch {
          // Already routed (an element can only be tapped once), or WebAudio
          // refused. Either way there's no boost to give; the slider stays put.
          return
        }
      }
    }
    // No graph and asking for more than 1× means the build didn't happen —
    // moving the slider then would be a lie about what you're hearing.
    if (!graphRef.current && v !== 1) return
    void graphRef.current?.ctx.resume().catch(() => { /* nothing to do */ })
    setBoost(v)
  }, [elRef])

  return { boost, setBoost: apply }
}

