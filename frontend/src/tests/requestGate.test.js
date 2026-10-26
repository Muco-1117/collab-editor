import { describe, expect, it } from 'vitest'
import { createLatestRequestGate } from '../lib/requestGate.js'

describe('latest request gate', () => {
  it('rejects an older response after a newer request starts', () => {
    const gate = createLatestRequestGate()
    const first = gate.begin()
    const second = gate.begin()

    expect(gate.isCurrent(first)).toBe(false)
    expect(gate.isCurrent(second)).toBe(true)
  })

  it('invalidates an in-flight response without starting another request', () => {
    const gate = createLatestRequestGate()
    const request = gate.begin()

    gate.invalidate()

    expect(gate.isCurrent(request)).toBe(false)
  })
})
