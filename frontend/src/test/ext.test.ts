import { describe, it, expect, beforeEach } from 'vitest'
import { hasCleanEmbed, resetCleanEmbedCache } from '../lib/ext'

/** The extension's content script, in one line (see extension/marker.js). */
function installExtension(value = '1') {
  document.documentElement.dataset.ytfeedEmbedClean = value
}

describe('hasCleanEmbed', () => {
  beforeEach(() => {
    delete document.documentElement.dataset.ytfeedEmbedClean
    resetCleanEmbedCache()
  })

  it('should report no clean embed when the extension is absent', () => {
    expect(hasCleanEmbed()).toBe(false)
  })

  it('should report a clean embed once the marker is set', () => {
    installExtension()
    expect(hasCleanEmbed()).toBe(true)
  })

  it('should treat an unknown marker version as absent', () => {
    // The value is a capability version. A future extension that needs the app
    // to behave differently bumps it, and THIS build must not claim support.
    installExtension('2')
    expect(hasCleanEmbed()).toBe(false)
  })

  it('should hold its answer for the life of the page', () => {
    // Deliberate: `controls` is a playerVar baked into the iframe URL when the
    // player is built. An answer that flipped mid-session would leave an
    // already-built player disagreeing with the bar drawn over it.
    expect(hasCleanEmbed()).toBe(false)
    installExtension()
    expect(hasCleanEmbed()).toBe(false)
  })
})
