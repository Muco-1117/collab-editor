import { describe, expect, it } from 'vitest'
import { applyOperation, createCollabState } from '../collab/collabState.js'
import { elementPatch, elementValues } from '../collab/elementValues.js'

const initial = {
  type: 'STATE',
  elementId: 'card',
  elementType: 'CARD',
  clock: 'seed:1',
  opId: 'seed',
  value: {
    text: '初始内容',
    column: 'todo',
    order: 1024,
    coverId: 'image',
    color: '#fff',
    '#tombstone': false,
  },
}

describe('partial editor actions on full element states', () => {
  it('uses current fields while preserving metadata, null values and the visibility marker', () => {
    const state = createCollabState()
    applyOperation(state, initial)
    applyOperation(state, {
      ...initial,
      clock: 'remote:2',
      opId: 'remote',
      value: { ...initial.value, text: '远端新内容', coverName: null },
    })
    expect(elementPatch(state, 'card', 'CARD', { column: 'done', order: 2048 })).toEqual({
      ...initial.value,
      text: '远端新内容',
      coverName: null,
      column: 'done',
      order: 2048,
    })
    expect(elementValues(state.elements.get('card'))).not.toHaveProperty('#version')
    expect(state.elements.get('card').fields.column.value).toBe('todo')
  })

  it('does not turn an action on a deleted or missing element into a new state', () => {
    const state = createCollabState()
    applyOperation(state, initial)
    applyOperation(state, {
      ...initial,
      clock: 'remote:2',
      opId: 'delete',
      value: { ...initial.value, '#tombstone': true },
    })
    expect(elementPatch(state, 'card', 'CARD', { text: 'stale edit' })).toBeNull()
    expect(elementPatch(state, 'missing', 'CARD', { text: 'stale edit' })).toBeNull()
    expect(state.deletedElements.get('card').fields['#tombstone'].value).toBe(true)
  })

  it('does not overwrite a remotely replaced element of a different type', () => {
    const state = createCollabState()
    applyOperation(state, initial)
    applyOperation(state, {
      ...initial,
      clock: 'remote:2',
      opId: 'image',
      elementType: 'IMAGE',
      value: { assetId: 'remote-image' },
    })
    expect(elementPatch(state, 'card', 'CARD', { text: 'stale edit' })).toBeNull()
    expect(elementPatch(state, 'card', 'IMAGE', { x: 50 })).toEqual({ assetId: 'remote-image', x: 50 })
  })
})
