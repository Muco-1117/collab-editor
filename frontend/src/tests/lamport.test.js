import { describe, expect, it } from 'vitest'
import { compareClocks, createLamport, observe, parseClock, tick } from '../collab/lamport.js'

describe('Lamport clock', () => {
  it('ticks with a positive counter', () => {
    expect(tick(0, 'client-a')).toEqual({ counter: 1, clock: 'client-a:1' })
  })

  it('observes the largest counter before advancing', () => {
    expect(observe(3, 'client-b:8')).toBe(9)
    const clock = createLamport('client-a', 2)
    clock.observe('client-b:7')
    expect(clock.tick()).toBe('client-a:9')
  })

  it('compares by counter and then replica id', () => {
    expect(compareClocks('z:3', 'a:4')).toBeLessThan(0)
    expect(compareClocks('z:4', 'a:4')).toBeGreaterThan(0)
    expect(compareClocks('a:4', 'B:4')).toBeGreaterThan(0)
    expect(compareClocks('a:4', 'a:4')).toBe(0)
    expect(parseClock('replica:with:colon:5')).toEqual({ replicaId: 'replica:with:colon', counter: 5 })
  })
})
