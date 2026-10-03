import { test, expect, watch, seek, pause, player, currentTime } from './fixtures'
import type { Page } from '@playwright/test'

// The player's keys, on a real <video>: what each does to the element itself.

const VIDEO = 'e2ePlayer00'
/** A property of the <video>, read off the element itself. */
const prop = (page: Page, key: 'paused' | 'muted' | 'volume' | 'playbackRate') =>
  player(page).evaluate((v, k) => (v as HTMLVideoElement)[k], key)

test.beforeEach(async ({ page }) => {
  await watch(page, VIDEO)
})

test('k pauses and plays', async ({ page }) => {
  await page.keyboard.press('k')
  await expect.poll(() => prop(page, 'paused')).toBe(true)
  await page.keyboard.press('k')
  await expect.poll(() => prop(page, 'paused')).toBe(false)
})

test('the seek keys move the play head by their step', async ({ page }) => {
  await pause(page)
  await seek(page, 12)
  await page.keyboard.press('l')
  await expect.poll(() => currentTime(page)).toBeCloseTo(22, 0)
  await page.keyboard.press('j')
  await expect.poll(() => currentTime(page)).toBeCloseTo(12, 0)
  await page.keyboard.press('ArrowLeft')
  await expect.poll(() => currentTime(page)).toBeCloseTo(7, 0)
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => currentTime(page)).toBeCloseTo(12, 0)
})

test('. and , step the speed, and the bar says so', async ({ page }) => {
  await page.keyboard.press('.')
  await expect.poll(() => prop(page, 'playbackRate')).toBeGreaterThan(1)
  const faster = await prop(page, 'playbackRate')
  await expect(page.getByRole('button', { name: 'Playback speed' })).toContainText(String(faster))
  await page.keyboard.press(',')
  await expect.poll(() => prop(page, 'playbackRate')).toBe(1)
})

test('m mutes and unmutes, and the arrows set the volume', async ({ page }) => {
  await page.keyboard.press('m')
  await expect.poll(() => prop(page, 'muted')).toBe(true)
  await page.keyboard.press('m')
  await expect.poll(() => prop(page, 'muted')).toBe(false)

  const before = Number(await prop(page, 'volume'))
  await page.keyboard.press('ArrowDown')
  await expect.poll(() => prop(page, 'volume')).toBeLessThan(before)
  await page.keyboard.press('ArrowUp')
  await expect.poll(() => prop(page, 'volume')).toBeCloseTo(before, 2)
})
