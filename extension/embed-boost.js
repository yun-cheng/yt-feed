/**
 * Volume boost INSIDE the embedded player.
 *
 * The app can amplify a video it serves itself: put a WebAudio gain node
 * between the <video> and the speakers. It cannot do that to an embed — the
 * player's <video> lives in this frame, on youtube.com, and the page holding the
 * iframe may not touch it. YouTube's own IFrame API stops at 100% volume, which
 * is the file's own loudness and no more.
 *
 * This script is the one place both halves meet: it runs in the embed frame,
 * where the element IS reachable, and takes a boost level from the app over
 * postMessage. Same trust boundary embed.css already crosses; nothing but a
 * number crosses it.
 *
 * Protocol (both directions carry `__ytFeed: 'boost'`):
 *   app → here    {op: 'ping'}              is anyone listening?
 *                 {op: 'set', value: 1..8}  amplify by this much
 *   here → app    {op: 'ready'}             yes, and this browser can do it
 *                 {op: 'result', ok, value} what actually happened
 *
 * The app asks first and only shows its control once this answers, so a browser
 * without WebAudio — or a page where the extension isn't loaded — simply has no
 * boost button rather than a dead one.
 */
(() => {
  // Only the app talks to us, and only from where the app can run. This mirrors
  // the extension's own host_permissions: a page on any other origin gets no
  // reply and no gain, whatever it sends.
  const APP_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/
  // Matches MAX_BOOST on the app side; the frame doesn't take its word for it.
  const MAX = 8

  const Ctx = window.AudioContext || window.webkitAudioContext
  let graph = null  // { ctx, gain } once built; built at most once per frame

  const reply = (origin, msg) => window.parent.postMessage({ __ytFeed: 'boost', ...msg }, origin)

  /** Route this frame's player through a gain node, once.
   *
   *  The context is STARTED BEFORE the audio is routed through it, deliberately:
   *  `createMediaElementSource` is a one-way door, and a context that stays
   *  suspended (autoplay policy — the click that asked for this happened in the
   *  app's frame, not in ours) would mean silence rather than a missing boost.
   *  If it won't run, we say so and leave the player exactly as it was. */
  async function build() {
    const el = document.querySelector('video')
    if (!el || !Ctx) return null
    const ctx = new Ctx()
    try {
      await ctx.resume()
    } catch {
      /* fall through to the state check */
    }
    if (ctx.state !== 'running') {
      void ctx.close().catch(() => {})
      return null
    }
    const gain = ctx.createGain()
    // A limiter after the gain. Multiplying a track that already peaks near full
    // scale only clips it, so past about 4× plain gain buys distortion rather
    // than volume; holding the peaks down is what makes the rest of the range
    // worth having.
    const cap = ctx.createDynamicsCompressor()
    cap.threshold.value = -6
    cap.knee.value = 6
    cap.ratio.value = 12
    cap.attack.value = 0.003
    cap.release.value = 0.25
    ctx.createMediaElementSource(el).connect(gain).connect(cap).connect(ctx.destination)
    return { ctx, gain }
  }

  window.addEventListener('message', async (e) => {
    const d = e.data
    if (!d || d.__ytFeed !== 'boost' || e.source !== window.parent) return
    if (!APP_ORIGIN.test(e.origin)) return

    if (d.op === 'ping') {
      if (Ctx) reply(e.origin, { op: 'ready' })
      return
    }
    if (d.op !== 'set') return

    const value = Math.max(1, Math.min(MAX, Number(d.value) || 1))
    if (!graph) {
      // 1× is what the player already does; there's no reason to take its audio
      // over just to leave it alone.
      if (value === 1) { reply(e.origin, { op: 'result', ok: true, value: 1 }); return }
      graph = await build()
      if (!graph) { reply(e.origin, { op: 'result', ok: false, value: 1 }); return }
    }
    // A context can be suspended out from under us (a background tab). With the
    // audio routed through it that's silence, so every change is a chance to
    // make sure it's still running.
    void graph.ctx.resume().catch(() => {})
    graph.gain.gain.value = value
    reply(e.origin, { op: 'result', ok: true, value })
  })
})()
