import { test, expect, watch, player, keepSettings } from './fixtures'
import type { Page } from '@playwright/test'

// Settings that shape the player and the pages, made in Settings and seen
// where they apply. Each is put back afterwards: the suite shares one account.

let restore: () => Promise<void>
test.beforeEach(async ({ page }) => {
  restore = await keepSettings(page, ['shortcuts', 'playback_speeds', 'page_defaults', 'video_panel_tab'])
})
test.afterEach(async () => { await restore() })

const muted = (page: Page) => player(page).evaluate((v: HTMLVideoElement) => v.muted)
const rate = (page: Page) => player(page).evaluate((v: HTMLVideoElement) => v.playbackRate)

test('a shortcut moved to another key answers there, and not on the old one', async ({ page }) => {
  await page.goto('/settings')
  const mute = page.getByRole('button', { name: 'Shortcut for Mute' })
  await mute.click()
  await page.keyboard.press('n')
  await expect(mute).toHaveText('N')

  await watch(page, 'e2ePlayer00')
  await page.keyboard.press('m')
  await page.waitForTimeout(300)
  expect(await muted(page)).toBe(false)
  await page.keyboard.press('n')
  await expect.poll(() => muted(page)).toBe(true)
})

test('the speeds listed are the steps . takes', async ({ page }) => {
  await page.goto('/settings')
  const speeds = page.getByRole('textbox', { name: 'Playback speeds' })
  await speeds.fill('1, 1.5, 3')
  await speeds.press('Enter')
  await expect(page.getByRole('button', { name: 'Reset' }).first()).toBeEnabled()

  await watch(page, 'e2ePlayer00')
  await page.keyboard.press('.')
  await expect.poll(() => rate(page)).toBe(1.5)
  await page.keyboard.press('.')
  await expect.poll(() => rate(page)).toBe(3)
})

test('Home opens on the time window set in Pages', async ({ page }) => {
  await page.goto('/settings')
  // Home's row comes first.
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/settings') && r.request().method() === 'PUT')
  await page.getByRole('button', { name: '1w', exact: true }).first().click()
  expect((await saved).ok()).toBe(true)

  await page.goto('/')
  await expect(page.getByRole('link', { name: 'Popular but older', exact: true }).first()).toBeVisible()
})

test('the panel opens on the tab Settings names', async ({ page }) => {
  await page.goto('/settings')
  await page.locator('div')
    .filter({ has: page.getByText('Panel on the video opens on', { exact: true }) })
    .filter({ has: page.locator('select') })
    .last().locator('select')
    .selectOption('transcript')

  await watch(page, 'e2eMarks000')
  await page.keyboard.press('g')
  await expect(page.getByRole('complementary', { name: 'Panel on the video' }).getByRole('tab', { name: 'Transcript' }))
    .toHaveAttribute('aria-selected', 'true')
})
