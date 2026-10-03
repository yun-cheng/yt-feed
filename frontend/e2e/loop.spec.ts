import { test, expect, watch, seek, pause, player, currentTime, clearMarks } from './fixtures'
import type { Page } from '@playwright/test'

// The A-B repeat, in real time: pinned with [ and ], it plays the passage over
// and over until \ lets go.

const VIDEO = 'e2eLoop0000'

/** Every play-head reading over `ms`, a tenth of a second apart. */
async function sample(page: Page, ms: number): Promise<number[]> {
  const times: number[] = []
  for (const end = Date.now() + ms; Date.now() < end;) {
    times.push(await currentTime(page))
    await page.waitForTimeout(100)
  }
  return times
}

test('a passage repeats until it is let go', async ({ page }) => {
  await clearMarks(page, VIDEO)
  await watch(page, VIDEO)
  await pause(page)
  await seek(page, 3)
  await page.keyboard.press('[')
  await seek(page, 5)
  await page.keyboard.press(']')

  await seek(page, 3)
  await player(page).evaluate((v: HTMLVideoElement) => v.play())
  const looping = await sample(page, 4500)
  // Round more than once, and never far past the end.
  expect(Math.max(...looping)).toBeLessThan(5.6)
  const laps = looping.filter((t, i) => i > 0 && t < looping[i - 1] - 1).length
  expect(laps).toBeGreaterThanOrEqual(1)

  await page.keyboard.press('\\')
  await expect.poll(() => currentTime(page), { timeout: 8_000 }).toBeGreaterThan(6)
})
