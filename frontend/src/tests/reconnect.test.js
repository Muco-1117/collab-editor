import { describe, expect, it } from 'vitest'
import { advanceRevision, reconnectDelay } from '../collab/reconnect.js'

describe('reconnect helpers', () => {
  it('uses exponential backoff with a cap', () => {
    expect([0, 1, 2, 3].map((attempt) => reconnectDelay(attempt))).toEqual([500, 1000, 2000, 4000])
    expect(reconnectDelay(20)).toBe(10000)
  })

  it('advances lastRev for all synchronization message shapes', () => {
    expect(advanceRevision(0, { type: 'welcome', rev: 12 })).toBe(12)
    expect(advanceRevision(12, { type: 'applied', rev: 13 })).toBe(13)
    expect(advanceRevision(13, { type: 'incremental', fromRev: 13, toRev: 18, ops: [] })).toBe(18)
    expect(advanceRevision(18, { type: 'incremental', fromRev: 18, ops: [{}, {}] })).toBe(20)
  })
})
