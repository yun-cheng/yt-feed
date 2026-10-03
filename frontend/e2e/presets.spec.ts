import { test, expect } from './fixtures'

// A preset: the sidebar's selection, named, and put back with one click.

test('a saved preset puts its filters back', async ({ page }) => {
  for (const p of await (await page.request.get('/api/presets')).json()) {
    if (p.name === 'Cooking only') await page.request.delete(`/api/presets/${p.id}`)
  }
  const soup = page.getByRole('link', { name: 'Soup in ten minutes', exact: true })
  const newer = page.getByRole('link', { name: 'Newer but quiet', exact: true })
  const food = page.getByRole('button', { name: /^(?!Hide )\S+ food( \d+)?$/ })

  await page.goto('/')
  await food.click()
  await expect(newer).toHaveCount(0)
  await page.getByRole('button', { name: 'save current' }).click()
  await page.getByRole('textbox', { name: 'Preset name' }).fill('Cooking only')
  await page.keyboard.press('Enter')

  await food.click()
  await expect(newer.first()).toBeVisible()

  await page.getByRole('button', { name: 'Cooking only', exact: true }).click()
  await expect(newer).toHaveCount(0)
  await expect(soup.first()).toBeVisible()
})
