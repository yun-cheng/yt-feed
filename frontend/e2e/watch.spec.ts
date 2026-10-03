import { test, expect, watch, pause, player, currentTime } from './fixtures'
import type { Page } from '@playwright/test'

// The watch page: reached from a card and left by Back, and the panel over
// the video — comments, the transcript, Ask AI, and which side it sits on.

const panel = (page: Page) => page.getByRole('complementary', { name: 'Panel on the video' })

async function openTab(page: Page, tab: string) {
  await page.keyboard.press('g')
  await panel(page).getByRole('tab', { name: tab }).click()
}

test('a card opens its video in the app, and the browser’s Back returns to the feed', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link', { name: 'Library one', exact: true }).last().click()
  await expect(page).toHaveURL(/\/watch\/e2eLibOne00/)
  await expect(player(page)).toHaveAttribute('src', /\/api\/downloads\/e2eLibOne00\/file/)

  await page.goBack()
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

  test('Notes keeps labels, a field of several values and a note, and typing stays out of the player', async ({ page }) => {
    const empty = { labels: [], fields: [], note: '' }
    await page.request.put('/api/notes/video/e2eMarks000', { data: empty })
    await page.request.put('/api/notes/video/e2eLibOne00', { data: empty })
    await page.reload()
    await pause(page)

    await openTab(page, 'Notes')
    const notes = panel(page)
    const add = async (box: string, text: string) => {
      await notes.getByLabel(box).fill(text)
      await notes.getByLabel(box).press('Enter')
    }
    await add('Add a label', 'comedy')
    await add('Add a label', 'rewatch')
    await add('Add a field', 'Actors')
    await expect(notes.getByLabel('Add to Actors')).toBeFocused()
    await add('Add to Actors', 'Ann')
    await add('Add to Actors', 'Bo')
    // "k" is play/pause, "f" fullscreen: written here, they're just letters.
    await notes.getByRole('textbox', { name: 'Note', exact: true }).pressSequentially('keep for the funny part')
    expect(await player(page).evaluate((v: HTMLVideoElement) => v.paused)).toBe(true)
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/notes/video/e2eMarks000') && r.request().method() === 'PUT')
    await saved
    await expect(notes.getByText('Saved')).toBeVisible()

    await page.reload()
    await pause(page)
    await openTab(page, 'Notes')
    await expect(notes.getByText('comedy', { exact: true })).toBeVisible()
    await expect(notes.getByText('rewatch', { exact: true })).toBeVisible()
    await expect(notes.getByTestId('note-field')).toHaveCount(1)
    await expect(notes.getByTestId('note-field').getByText('Ann', { exact: true })).toBeVisible()
    await expect(notes.getByTestId('note-field').getByText('Bo', { exact: true })).toBeVisible()
    await expect(notes.getByRole('textbox', { name: 'Note', exact: true })).toHaveValue('keep for the funny part')

    // Another video offers what this one used.
    await watch(page, 'e2eLibOne00')
    await pause(page)
    await openTab(page, 'Notes')
    const offered = async (box: string) => {
      const id = await notes.getByLabel(box).getAttribute('list')
      return page.locator(`datalist[id="${id}"] option`).evaluateAll((os) => os.map((o) => o.getAttribute('value')))
    }
    expect(await offered('Add a label')).toEqual(expect.arrayContaining(['comedy', 'rewatch']))
    await add('Add a field', 'Actors')
    expect(await offered('Add to Actors')).toEqual(expect.arrayContaining(['Ann', 'Bo']))
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
