import { test, expect } from './fixtures'

// A stream's chat over the picture: the page's wiring of the chat's fetch to
// the 彈幕 and to the counts of what's being said at its side.

const say = (t: number, a: string, text: string) => ({ t, a, r: [text] })
const chat = [
  ...Array.from({ length: 12 }, (_, i) => say(300 + i * 300, `@a${i}`, ['a', 'A', '我選A', 'i choose a'][i % 4])),
  ...Array.from({ length: 9 }, (_, i) => say(500 + i * 350, `@b${i}`, ['b', 'b', 'i pick b'][i % 3])),
  ...Array.from({ length: 5 }, (_, i) => say(400 + i * 600, `@c${i}`, `something else to say, number ${i}`)),
].sort((p, q) => p.t - q.t)

test('the chat flies across the picture once, with what it’s saying counted at the side', async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('ytfeed:danmaku')) localStorage.setItem('ytfeed:danmaku', '{"on":true}')
  })
  await page.route('**/api/feed/description/*', (r) => r.fulfill({ json: { description: '', chapters: [], chat: true } }))
  await page.route('**/api/chat/*', (r) => r.fulfill({ json: { status: 'done', messages: chat } }))
  await page.goto('/watch/e2eMarks000')

  const counts = page.locator('.danmaku-phrase')
  await expect(counts.filter({ hasText: /^(a|A)×/ })).toBeVisible()
  await expect(counts.filter({ hasText: /^b×/ })).toBeVisible()
  await expect.poll(() => page.locator('.danmaku-item').count()).toBeGreaterThan(0)

  // One layer, whatever the page has re-rendered since, each message once.
  await expect(page.getByTestId('danmaku')).toHaveCount(1)
  expect(await page.locator('.danmaku-item').count()).toBeLessThanOrEqual(chat.length)

  // Its switch takes the counts away and leaves the 彈幕 flying.
  await page.getByRole('button', { name: 'Turn danmaku off' }).hover()
  await page.getByRole('switch', { name: 'Count repeated phrases' }).click()
  await expect(counts).toHaveCount(0)
  await expect(page.getByTestId('danmaku')).toHaveCount(1)
})
