import { compareClocks } from './lamport.js'

function encodeClock(clock) {
  if (typeof clock === 'string') return clock
  if (clock?.replica && Number.isFinite(Number(clock.counter))) return `${clock.replica}:${clock.counter}`
  return ''
}

function normalizeField(field) {
  if (field && typeof field === 'object' && Object.hasOwn(field, 'value')) {
    return { value: field.value, clock: encodeClock(field.clock) }
  }
  return { value: field, clock: '' }
}

export function latestClockInSnapshot(snapshot = []) {
  let maximum = ''
  for (const element of snapshot || []) {
    const candidates = [element?.rootClock, element?.root_clock]
    for (const field of Object.values(element?.fields || {})) candidates.push(field?.clock)
    for (const candidate of candidates) {
      const encoded = encodeClock(candidate)
      if (encoded && (!maximum || compareClocks(encoded, maximum) > 0)) maximum = encoded
    }
  }
  return maximum
}

function cloneElement(element) {
  const fields = {}
  Object.entries(element?.fields || {}).forEach(([name, field]) => {
    fields[name] = normalizeField(field)
  })
  return {
    id: String(element?.id || ''),
    type: element?.type || 'TEXT',
    rootClock: element?.rootClock || element?.root_clock || '',
    fields,
  }
}

export function createCollabState(snapshot = []) {
  const state = { elements: new Map(), tombstones: new Map(), deletedElements: new Map() }
  loadSnapshot(state, snapshot)
  return state
}

export function loadSnapshot(state, snapshot = []) {
  state.elements.clear()
  state.tombstones.clear()
  state.deletedElements.clear()
  for (const raw of snapshot || []) {
    const element = cloneElement(raw)
    if (!element.id) continue
    placeElement(state, element)
  }
  return state
}

function findElement(state, elementId) {
  return state.elements.get(elementId) || state.deletedElements.get(elementId)
}

function placeElement(state, element) {
  const tombstone = element.fields['#tombstone']
  if (tombstone?.value === true) {
    state.elements.delete(element.id)
    state.deletedElements.set(element.id, element)
    state.tombstones.set(element.id, tombstone.clock)
    return
  }
  state.deletedElements.delete(element.id)
  state.tombstones.delete(element.id)
  state.elements.set(element.id, element)
}

function ensureElement(state, operation) {
  let element = findElement(state, operation.elementId)
  let changed = false
  if (!element) {
    element = {
      id: operation.elementId,
      type: operation.elementType || 'TEXT',
      rootClock: operation.clock,
      fields: {},
    }
    changed = true
  } else if (compareClocks(operation.clock, element.rootClock) > 0) {
    element.type = operation.elementType || element.type
    element.rootClock = operation.clock
    changed = true
  }
  return { element, changed }
}

export function applyOperation(state, operation) {
  if (!operation?.elementId || !operation?.clock) return false
  const type = String(operation.type || '').toUpperCase()
  if (!['ADD', 'PUT', 'DELETE', 'STATE'].includes(type)) return false
  if (type === 'PUT' && !operation.field) return false

  if (type === 'STATE') {
    const previous = findElement(state, operation.elementId)
    const version = previous?.fields?.['#version']?.clock || ''
    const compared = version ? compareClocks(operation.clock, version) : 1
    if (compared < 0 || (compared === 0 && String(operation.opId || '') <= String(previous?.fields?.['#version']?.value || ''))) return false
    const fields = {}
    for (const [key, value] of Object.entries(operation.value || {})) fields[key] = { value, clock: operation.clock }
    fields['#version'] = { value: operation.opId, clock: operation.clock }
    placeElement(state, { id: operation.elementId, type: operation.elementType, rootClock: operation.clock, fields })
    return true
  }
  if (findElement(state, operation.elementId)?.fields?.['#version']) return false

  const { element, changed: identityChanged } = ensureElement(state, operation)

  if (type === 'ADD') {
    // ADD only merges element identity. In particular, it never clears a tombstone.
    placeElement(state, element)
    return identityChanged
  }

  const field = type === 'DELETE' ? '#tombstone' : operation.field
  const value = type === 'DELETE' ? true : operation.value
  const current = element.fields[field]
  let fieldChanged = false
  if (!current || compareClocks(operation.clock, current.clock) > 0) {
    element.fields[field] = { value, clock: operation.clock }
    fieldChanged = true
  }

  // Visibility is controlled only by the LWW value of #tombstone. Other writes can
  // still merge while hidden, but cannot accidentally resurrect the element.
  placeElement(state, element)
  return identityChanged || fieldChanged
}

export function fieldValue(element, field, fallback = '') {
  const value = element?.fields?.[field]?.value
  return value == null ? fallback : value
}

export function visibleElements(state, type = null) {
  const elements = [...state.elements.values()]
  return type ? elements.filter((element) => element.type === type) : elements
}
