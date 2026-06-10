import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

// Minimal canvas getContext stub — jsdom does not implement Canvas 2D, but
// the primitive's renderer is never invoked in these unit tests. Without this
// stub, anything that touches a canvas (ResizeObserver, etc.) would throw.
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
