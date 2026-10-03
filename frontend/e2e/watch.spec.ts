import { test, expect, watch, pause, player, currentTime } from './fixtures'
import type { Page } from '@playwright/test'

// The watch page: reached from a card and left by Back, and the panel over
// the video — comments, the transcript, Ask AI, and which side it sits on.

const panel = (page: Page) => page.getByRole('complementary', { name: 'Panel on the video' })

async function openTab(page: Page, tab: string) {
  await page.keyboard.press('g')
  await panel(page).getByRole('tab', { name: tab }).click()
}

test('a card opens its video in the app, and Back returns to the feed', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link', { name: 'Library one', exact: true }).last().click()
  await expect(page).toHaveURL(/\/watch\/e2eLibOne00/)
  await expect(player(page)).toHaveAttribute('src', /\/api\/downloads\/e2eLibOne00\/file/)

  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(player(page)).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Library two', exact: true }).first()).toBeVisible()
})

test.describe('the panel', () => {
  test.beforeEach(async ({ page }) => {
    await watch(page, 'e2eMarks000')
    await pause(page)
  })

  test('Comments shows the video’s comments', async ({ page }) => {
    await openTab(page, 'Comments')
    await expect(panel(page).getByText('Skip to 0:12 for the good part.')).toBeVisible()
    await expect(panel(page).getByText('@viewer')).toBeVisible()
  })

  test('Transcript reads the captions as sentences, and a click seeks', async ({ page }) => {
    await openTab(page, 'Transcript')
    await expect(panel(page).getByRole('button', { name: /The first caption\./ })).toBeVisible()
    await panel(page).getByRole('button', { name: /The second caption\./ }).click()
    await expect.poll(() => currentTime(page)).toBeCloseTo(4, 0)
  })

  test('Ask AI streams its answer, and a time in it seeks', async ({ page }) => {
    await openTab(page, 'Ask AI')
    // The suggestions show once the thread so far has loaded. Asked before
    // then, the empty thread arriving late would wipe the question.
    await expect(panel(page).getByRole('button', { name: 'Short summary' })).toBeVisible()
    await panel(page).getByPlaceholder('Ask about this video').fill('When does it change?')
    await page.keyboard.press('Enter')
    await expect(panel(page).getByText('where the second caption comes in.')).toBeVisible()
    await panel(page).getByRole('button', { name: '0:06' }).click()
    await expect.poll(() => currentTime(page)).toBeCloseTo(6, 0)
  })

  test('it moves to the other side and back', async ({ page }) => {
    await page.keyboard.press('g')
    const x = async () => (await panel(page).boundingBox())!.x
    const width = page.viewportSize()!.width
    expect(await x()).toBeGreaterThan(width / 2)
    await panel(page).getByRole('button', { name: 'Move to the left' }).click()
    await expect.poll(x).toBeLessThan(width / 2)
    await panel(page).getByRole('button', { name: 'Move to the right' }).click()
    await expect.poll(x).toBeGreaterThan(width / 2)
  })
})
