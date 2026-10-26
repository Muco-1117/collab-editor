import { describe, expect, it } from 'vitest'
import { applyOperation, createCollabState, fieldValue, latestClockInSnapshot } from '../collab/collabState.js'

const put = (value, clock) => ({
  type: 'PUT', elementId: 'p-1', elementType: 'TEXT', field: 'text', value, clock,
})

describe('collaboration state', () => {
  it('keeps the field with the greatest LWW clock', () => {
    const state = createCollabState()
    applyOperation(state, put('newer', 'b:4'))
    applyOperation(state, put('older', 'z:3'))
    expect(fieldValue(state.elements.get('p-1'), 'text')).toBe('newer')
  })

  it('is idempotent for a server echo with the same clock', () => {
    const state = createCollabState()
    expect(applyOperation(state, put('draft', 'a:1'))).toBe(true)
    expect(applyOperation(state, put('draft', 'a:1'))).toBe(false)
    expect(state.elements.size).toBe(1)
  })

  it('uses replica id to settle equal counters', () => {
    const state = createCollabState()
    applyOperation(state, put('alpha', 'a:2'))
    applyOperation(state, put('zulu', 'z:2'))
    expect(fieldValue(state.elements.get('p-1'), 'text')).toBe('zulu')
  })

  it('keeps a tombstone from being revived by add or ordinary field writes', () => {
    const state = createCollabState()
    applyOperation(state, put('before delete', 'a:2'))
    applyOperation(state, { type: 'DELETE', elementId: 'p-1', elementType: 'TEXT', clock: 'a:5' })
    expect(applyOperation(state, { type: 'ADD', elementId: 'p-1', elementType: 'TEXT', clock: 'b:3' })).toBe(false)
    expect(applyOperation(state, put('stale but mergeable', 'c:4'))).toBe(true)
    expect(applyOperation(state, put('newer but still hidden', 'c:6'))).toBe(true)
    expect(applyOperation(state, {
      type: 'PUT', elementId: 'p-1', elementType: 'TEXT', field: '#tombstone', value: null, clock: 'c:4',
    })).toBe(false)
    expect(state.elements.has('p-1')).toBe(false)
    expect(fieldValue(state.deletedElements.get('p-1'), 'text')).toBe('newer but still hidden')
  })

  it('revives a deleted element only when a newer tombstone clear arrives', () => {
    const state = createCollabState()
    applyOperation(state, put('before delete', 'a:2'))
    applyOperation(state, { type: 'DELETE', elementId: 'p-1', elementType: 'TEXT', clock: 'a:5' })
    applyOperation(state, put('updated while hidden', 'b:6'))
    expect(state.elements.has('p-1')).toBe(false)
    expect(applyOperation(state, {
      type: 'PUT', elementId: 'p-1', elementType: 'TEXT', field: '#tombstone', value: null, clock: 'server-restore:7',
    })).toBe(true)
    expect(fieldValue(state.elements.get('p-1'), 'text')).toBe('updated while hidden')
    expect(state.tombstones.has('p-1')).toBe(false)

    expect(applyOperation(state, {
      type: 'DELETE', elementId: 'p-1', elementType: 'TEXT', clock: 'late-delete:6',
    })).toBe(false)
    expect(state.elements.has('p-1')).toBe(true)
  })

  it('retains a cleared tombstone clock loaded from a snapshot', () => {
    const state = createCollabState([{
      id: 'p-1', type: 'TEXT', rootClock: 'restore:8', fields: {
        '#tombstone': { value: null, clock: 'restore:8' },
        text: { value: 'restored', clock: 'author:3' },
      },
    }])

    expect(applyOperation(state, {
      type: 'DELETE', elementId: 'p-1', elementType: 'TEXT', clock: 'author:7',
    })).toBe(false)
    expect(fieldValue(state.elements.get('p-1'), 'text')).toBe('restored')
  })

  it('finds the greatest clock in a welcome or replay snapshot', () => {
    const snapshot = [{
      id: 'p-1', type: 'TEXT', fields: {
        text: { value: 'hello', clock: 'peer-b:12' },
        order: { value: 1, clock: { replica: 'peer-a', counter: 15 } },
      },
    }]
    expect(latestClockInSnapshot(snapshot)).toBe('peer-a:15')
  })
})
