import { describe, expect, it } from 'vitest'
import { applyOperation, createCollabState, fieldValue } from '../collab/collabState.js'
describe('v2 full element LWW', () => {
  it('converges with shuffled image changes, deletion and duplicates', () => {
    const operations = [
      { type: 'STATE', elementId: 'image', elementType: 'IMAGE', clock: 'a:1', opId: 'a', value: { assetId: 'first', x: 10 } },
      { type: 'STATE', elementId: 'image', elementType: 'IMAGE', clock: 'b:2', opId: 'b', value: { assetId: 'second' } },
      { type: 'STATE', elementId: 'image', elementType: 'IMAGE', clock: 'c:3', opId: 'c', value: { assetId: 'second', '#tombstone': true } },
    ]
    const a = createCollabState(), b = createCollabState()
    operations.forEach(op => applyOperation(a, op))
    ;[...operations].reverse().forEach(op => { applyOperation(b, op); applyOperation(b, op) })
    expect(a.deletedElements.get('image')).toEqual(b.deletedElements.get('image'))
    expect(a.elements.size).toBe(0)
  })
  it('replaces complete metadata and uses operation ID for an equal clock', () => {
    const state = createCollabState()
    const base = { type: 'STATE', elementId: 'p', elementType: 'TEXT', clock: 'a:1' }
    applyOperation(state, { ...base, opId: 'a', value: { text: 'old', extra: true } })
    applyOperation(state, { ...base, opId: 'b', value: { text: 'winner' } })
    applyOperation(state, { ...base, opId: 'a', value: { text: 'old' } })
    expect(fieldValue(state.elements.get('p'), 'text')).toBe('winner')
    expect(state.elements.get('p').fields.extra).toBeUndefined()
  })
})
