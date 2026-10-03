import { readFileSync } from 'node:fs'
import { request, type FullConfig } from '@playwright/test'

/**
 * Sign in the way a new deployment's owner does: claim it with the setup
 * token the server wrote to its data directory. The claim signs the browser
 * in, and its cookie is what every spec starts with.
 */
export default async function globalSetup(config: FullConfig) {
  const { baseURL, storageState } = config.projects[0].use
  const token = readFileSync(new URL('./.run/data/setup-token', import.meta.url), 'utf8').trim()
  const api = await request.newContext({ baseURL })
  const res = await api.post('/api/setup/claim', { data: { token } })
  if (!res.ok()) throw new Error(`claiming the e2e deployment failed: ${res.status()} ${await res.text()}`)
  await api.storageState({ path: storageState as string })
  await api.dispose()
}
