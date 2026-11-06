import { describe, it, expect } from 'vitest'
import { trueClock } from '../lib/trueClock'

describe('the player’s real speed', () => {
  // Frames 16ms apart through an embed told 1× while its video plays at
  // `truth`, reporting where it is every half second.
  const run = (truth: number, ms: number, from = { now: 0, time: 0 }, said = 1, clock = trueClock()) => {
    let { now, time } = from
    let report = { at: now, r: time }
    let out: ReturnType<ReturnType<typeof trueClock>['read']> = null
    for (let t = 0; t < ms; t += 16) {
      now += 16
      time += 0.016 * truth
      if (now - report.at >= 500) report = { at: now, r: time }
      out = clock.read(now, report.r + ((now - report.at) / 1000) * said, said, true)
    }
    return { out, now, time, clock }
  }

  it('is measured from where the player keeps putting its time right', () => {
    const { out, time } = run(1.5, 3000)
    expect(out?.speed).toBeCloseTo(1.5)
    expect(Math.abs(out!.time - time)).toBeLessThan(0.03)
  })

  it('works slower than the player says too', () => {
    const { out, time } = run(0.5, 3000)
    expect(out?.speed).toBeCloseTo(0.5)
    expect(Math.abs(out!.time - time)).toBeLessThan(0.03)
  })

  it('is the player’s own word when that’s right, and again once it’s right again', () => {
    expect(run(1, 3000).out).toBeNull()
    expect(run(1.5, 3000, undefined, 1.5).out).toBeNull()
    const sped = run(1.5, 3000)
    expect(sped.out).not.toBeNull()
    expect(run(1, 2000, sped, 1, sped.clock).out).toBeNull()
  })

  it('starts over on a pause', () => {
    const { clock, now, time } = run(1.5, 3000)
    expect(clock.read(now + 16, time, 1, false)).toBeNull()
    expect(clock.read(now + 32, time, 1, true)).toBeNull()
  })

  it('reads a steady speed steadily, however late each report arrives', () => {
    // At 1.3×, each report reaching the page up to 40ms late: over one half
    // second gap that alone reads anywhere from 1.22× to 1.38×.
    const clock = trueClock()
    let seed = 7
    const late = () => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647) * 40 }
    let now = 0
    let report = { at: 0, r: 0 }
    const seen = new Set<number | null>()
    for (let i = 0; i < 1000; i++) {
      now += 16
      if (now - report.at >= 500) {
        const sent = now - late()
        report = { at: now, r: (sent / 1000) * 1.3 }
      }
      const out = clock.read(now, report.r + (now - report.at) / 1000, 1, true)
      if (now > 3000) seen.add(out?.speed ?? null)
    }
    expect([...seen]).toEqual([1.3])
  })

  it('still catches a new speed by the second report after it', () => {
    const sped = run(1.3, 4000)
    expect(sped.out?.speed).toBeCloseTo(1.3)
    const { out } = run(1.8, 1100, sped, 1, sped.clock)
    expect(out?.speed).toBeCloseTo(1.8)
  })
})
