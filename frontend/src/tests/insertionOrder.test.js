import { describe, expect, it } from 'vitest'
import { planInsertionOrder } from '../collab/insertionOrder.js'
import { compareElementOrder } from '../collab/ordering.js'

function element(id, order) {
  return { id, type: 'TEXT', fields: { order: { value: order } } }
}

function insert(elements, index, id) {
  const plan = planInsertionOrder(elements, index)
  const updates = new Map(plan.updates.map((update) => [update.id, update.order]))
  const result = elements.map((item) =>
    element(item.id, updates.has(item.id) ? updates.get(item.id) : item.fields.order.value),
  )
  result.push(element(id, plan.order))
  return result.sort(compareElementOrder).map((item) => item.id)
}

describe('editor insertion after concurrent equal positions', () => {
  it('keeps normal insertions to one element operation', () => {
    const values = [element('a', 1024), element('b', 2048)]
    expect(planInsertionOrder(values, 1)).toEqual({ order: 1536, updates: [] })
    expect(planInsertionOrder(values, 0)).toEqual({ order: 0, updates: [] })
    expect(planInsertionOrder(values, 2)).toEqual({ order: 3072, updates: [] })
  })

  it('inserts into colliding positions independently of the new element id', () => {
    const values = [element('a', 1024), element('b', 1024), element('c', 2048)]
    expect(insert(values, 1, 'z')).toEqual(['a', 'z', 'b', 'c'])
    expect(insert(values, 1, '0')).toEqual(['a', '0', 'b', 'c'])
  })

  it('opens a gap when a midpoint or end position cannot be represented', () => {
    const tight = [element('a', 1), element('b', 1 + Number.EPSILON)]
    expect(insert(tight, 1, 'new')).toEqual(['a', 'new', 'b'])
    const large = [element('a', Number.MAX_VALUE)]
    expect(insert(large, 1, 'new')).toEqual(['a', 'new'])
  })

  it('does not mutate metadata or input order while planning normalization', () => {
    const values = [element('a', 0), element('b', 0)]
    values[0].fields.text = { value: '内容不能被重排覆盖' }
    const original = structuredClone(values)
    expect(planInsertionOrder(values, 1).updates).toEqual([
      { id: 'a', type: 'TEXT', order: 1024 },
      { id: 'b', type: 'TEXT', order: 2048 },
    ])
    expect(values).toEqual(original)
  })
})
