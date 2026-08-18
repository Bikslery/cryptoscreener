import { describe, it, expect } from 'vitest'
import { eventToCombo, normalizeCombo } from '../drawingHotkeys'

describe('eventToCombo', () => {
  it('returns shift+d for Shift+KeyD on English layout', () => {
    const e = new KeyboardEvent('keydown', {
      key: 'D',
      code: 'KeyD',
      shiftKey: true,
    })
    expect(eventToCombo(e)).toBe('shift+d')
  })

  it('returns shift+d for Shift+KeyD on Russian layout (e.key="Д")', () => {
    const e = new KeyboardEvent('keydown', {
      key: 'Д',
      code: 'KeyD',
      shiftKey: true,
    })
    expect(eventToCombo(e)).toBe('shift+d')
  })

  it('returns shift+s for Shift+KeyS on Russian layout (e.key="Ы")', () => {
    const e = new KeyboardEvent('keydown', {
      key: 'Ы',
      code: 'KeyS',
      shiftKey: true,
    })
    expect(eventToCombo(e)).toBe('shift+s')
  })

  it('returns shift+a for Shift+KeyA on Russian layout (e.key="Ф")', () => {
    const e = new KeyboardEvent('keydown', {
      key: 'Ф',
      code: 'KeyA',
      shiftKey: true,
    })
    expect(eventToCombo(e)).toBe('shift+a')
  })

  it('returns ctrl+shift+d for Ctrl+Shift+KeyD', () => {
    const e = new KeyboardEvent('keydown', {
      key: 'D',
      code: 'KeyD',
      ctrlKey: true,
      shiftKey: true,
    })
    expect(eventToCombo(e)).toBe('ctrl+shift+d')
  })

  it('matches normalized default bindings', () => {
    const e = new KeyboardEvent('keydown', {
      key: 'Д',
      code: 'KeyD',
      shiftKey: true,
    })
    const combo = eventToCombo(e)
    const binding = normalizeCombo('shift+d')
    expect(combo).toBe(binding)
  })

  it('ignores modifier-only keys', () => {
    const e = new KeyboardEvent('keydown', {
      key: 'Shift',
      code: 'ShiftLeft',
      shiftKey: true,
    })
    expect(eventToCombo(e)).toBe('shift')
  })

  it('handles non-letter keys via e.key fallback', () => {
    const e = new KeyboardEvent('keydown', {
      key: 'Delete',
      code: 'Delete',
    })
    expect(eventToCombo(e)).toBe('delete')
  })
})
