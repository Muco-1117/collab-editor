// STATE replaces the whole element. Read its latest fields immediately before
// applying a partial UI change so remote text, image metadata and tombstones
// are not replaced by the object captured when an interaction started.
export function elementValues(element) {
  return Object.fromEntries(
    Object.entries(element?.fields || {})
      .filter(([key]) => key !== '#version')
      .map(([key, field]) => [key, field.value]),
  )
}

export function elementPatch(state, elementId, elementType, changes) {
  const current = state.elements.get(elementId)
  if (!current || current.type !== elementType || current.fields?.['#tombstone']?.value === true) return null
  return { ...elementValues(current), ...changes }
}
