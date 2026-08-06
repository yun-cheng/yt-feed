import '@testing-library/jest-dom'

// jsdom ships neither of these, and Radix's slider reaches for both on mount:
// ResizeObserver to track the track's width, setPointerCapture to own the drag.
// Without them the component throws before it ever renders.
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
}
