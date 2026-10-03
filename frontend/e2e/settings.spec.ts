import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

// Settings that change the whole app, saved to the account: they hold across
// a reload, and every other spec expects them back at their defaults after.

/** The <select> in the settings row labelled `label`. */
const choice = (page: Page, label: string) =>
  page.locator('div').filter({ has: page.getByText(label, { exact: true }) }).filter({ has: page.locator('select') }).last().locator('select')

test.afterEach(async ({ page }) => {
  const res = await page.request.put('/api/settings', { data: { values: { app_language: 'auto', theme: 'dark' } } })
  expect(res.ok()).toBe(true)
})

test('the app language switches every label, and holds across a reload', async ({ page }) => {
  await page.goto('/settings')
  await choice(page, 'App language').selectOption('zh-Hant')
  await expect(page.getByRole('button', { name: '設定', exact: true }).first()).toBeVisible()

  await page.reload()
  await expect(page.getByRole('button', { name: '我的首頁', exact: true }).first()).toBeVisible()
})

test('the light theme lands on the page, and holds across a reload', async ({ page }) => {
  await page.goto('/settings')
  await choice(page, 'Theme').selectOption('light')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  expect(bg).not.toBe('rgb(15, 15, 15)')
})
