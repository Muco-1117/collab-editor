import { describe, expect, it } from 'vitest'
import { compareElementOrder, orderBetween } from '../collab/ordering.js'

function element(id, order) {
  return { id, fields: { order: { value: order, clock: 'test:1' } } }
}

describe('ordered collaborative elements', () => {
  it('uses the element id as a deterministic tie breaker', () => {
    const values = [element('card-c', 10), element('card-a', 10), element('card-b', 5)]
    expect(values.sort(compareElementOrder).map((item) => item.id)).toEqual(['card-b', 'card-a', 'card-c'])
  })

  it('allocates positions at the beginning, middle, and end', () => {
    expect(orderBetween(null, null)).toBe(1024)
    expect(orderBetween(null, -1024)).toBe(-2048)
    expect(orderBetween(10, 20)).toBe(15)
    expect(orderBetween(20, null)).toBe(1044)
  })
})
