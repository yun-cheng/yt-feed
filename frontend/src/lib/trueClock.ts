/**
 * The player's real speed, when it's wrong about it, which the danmaku
 * (components/Danmaku) runs at.
 */

/** How far a frame's move in the player's time may stray from what its speed
 *  says before it counts as the player putting its time right (a leap). */
const LEAP_SEC = 0.05

/** How long after its last leap the measured speed still stands, at least:
 *  the player puts its time right every half second or so while it's wrong
 *  about its speed, so two of those gaps without one (LEAP_STALE_GAPS) means
 *  it's right again. */
const LEAP_STALE_MS = 700
const LEAP_STALE_GAPS = 2.2
/** Leaps further apart than this say nothing about the speed between them. */
const LEAP_SPAN_MS = 3000

/** A measured speed is taken as the player's real speed only this far from
 *  what the player says, in twentieths (so 1.55, not 1.5500000000000003). */
const SPEED_OFF = 0.1
const SPEED_STEPS = 20

/** The speed is read across the leaps of this long, not just the last two:
 *  when each report arrives wobbles by some hundredths of a second, which
 *  over one half-second gap is a few hundredths of speed — enough for 1.3× to
 *  read now 1.25×, now 1.35× — and over this long, a fifth of that. */
const WINDOW_MS = 2500
/** A last pair that reads this far from the speed is a new one, not a wobble:
 *  the leaps before it are let go, so it's caught at once. */
const NEW_SPEED = 0.1
/** Reports come a quarter or half second apart, and between them the player's
 *  time runs true to what it says: leaps closer than this are its time
 *  wobbling, not being put right, and nothing it says can be read then. */
const LEAP_GAP_MS = 200
/** How far a leap may be from the size its speed says it should have — the
 *  speed's gain on the player's, over the time since the report before — for
 *  a reading from the last two alone: a real report is that size, a wobble
 *  any size at all. */
const LEAP_FIT = 0.04

/** And a reading moves off the speed it has only by this much, past the
 *  halfway mark to the next twentieth, so one hovering there doesn't flick. */
const STICK = 0.035

/**
 * The player's real speed and time, when it's wrong about them.
 *
 * A speed set behind the embed's back — by another extension, on the video
 * inside it — leaves the embed saying 1×, and its time follows suit: carried
 * on at 1× between the video's reports of where it really is, every half
 * second or so, so it creeps and then leaps. Those leaps are the truth: from
 * the leaps of the last few seconds, the real speed (a new one is caught by
 * the second report after it, see NEW_SPEED), and from the last, the real
 * time since. Null while the player's word holds.
 */
export function trueClock() {
  let prev: { at: number; r: number; said: number } | null = null
  // Each leap: when, the player's time then, and by how much it leapt.
  let leaps: { at: number; r: number; by: number }[] = []
  let speed: number | null = null
  // The speed as read, before it's rounded; null till there's a reading.
  let raw: number | null = null
  // How long a measured speed outlives its last leap.
  let stale = LEAP_STALE_MS
  const slope = (a: { at: number; r: number }, b: { at: number; r: number }) => (b.r - a.r) / ((b.at - a.at) / 1000)
  return {
    /** One frame: the player's time `r` and speed `said` at `now` (ms). */
    read(now: number, r: number, said: number, playing: boolean): { speed: number; time: number } | null {
      const last = prev
      prev = { at: now, r, said }
      // Still, a new speed of its own, or a first look: start over.
      if (!playing || !last || last.said !== said) { leaps = []; speed = null; raw = null; return null }
      const moved = r - last.r
      // Far enough to be a seek: start over from here.
      if (Math.abs(moved) > 2) { leaps = []; speed = null; raw = null; return null }
      const by = moved - ((now - last.at) / 1000) * said
      const before = leaps[leaps.length - 1]
      // Wobbling: start over.
      if (Math.abs(by) > LEAP_SEC && before && now - before.at < LEAP_GAP_MS) { leaps = []; speed = null; raw = null; return null }
      if (Math.abs(by) > LEAP_SEC) {
        const leap = { at: now, r, by }
        // Too long since the last to say anything about the speed between.
        if (before && leap.at - before.at > LEAP_SPAN_MS) leaps = []
        // A new speed: what came before it is another speed's.
        else if (before && raw !== null && Math.abs(slope(before, leap) - raw) > NEW_SPEED) leaps = [before]
        leaps.push(leap)
        while (leaps.length > 2 && leap.at - leaps[0].at > WINDOW_MS) leaps.shift()
        if (leaps.length >= 2) {
          const v = slope(leaps[0], leap)
          // Read off the last two alone, the leap must be the size that speed
          // makes it.
          const fits = leaps.length > 2 || Math.abs(by - (v - said) * ((leap.at - leaps[0].at) / 1000)) <= LEAP_FIT
          // A speed a player can have: a short seek reads as a wild one.
          if (fits && v >= 0.25 && v <= 4) {
            raw = v
            const m = speed !== null && Math.abs(v - speed) < STICK ? speed : Math.round(v * SPEED_STEPS) / SPEED_STEPS
            speed = Math.abs(m - said) >= SPEED_OFF ? m : null
            stale = Math.max(LEAP_STALE_MS, (leap.at - before!.at) * LEAP_STALE_GAPS)
          }
        }
      }
      const at = leaps[leaps.length - 1]
      if (speed === null || !at) return null
      if (now - at.at > stale) { leaps = []; speed = null; return null }
      return { speed, time: at.r + ((now - at.at) / 1000) * speed }
    },
  }
}
