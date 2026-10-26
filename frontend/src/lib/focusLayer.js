// One stack coordinates dialogs and the mobile drawer, including nested dialogs.
const layers = []
let bodyWasLocked = false

const focusableSelector =
  'a[href], button, input, select, textarea, summary, iframe, [contenteditable="true"], [tabindex]'

function canFocus(element) {
  return (
    element instanceof HTMLElement &&
    element.isConnected &&
    !element.matches(':disabled') &&
    !element.closest('[inert]') &&
    element.getClientRects().length > 0 &&
    !['hidden', 'collapse'].includes(getComputedStyle(element).visibility)
  )
}

function tabbableElements(container) {
  return [...container.querySelectorAll(focusableSelector)].filter(
    (element) => element.tabIndex >= 0 && canFocus(element),
  )
}

function topLayer() {
  return layers.at(-1)
}

function focusInside(layer, preferLast = false) {
  if (!layer || topLayer() !== layer || !layer.container.isConnected) return
  const remembered = preferLast && layer.lastFocused
  const autofocus = layer.container.querySelector('[autofocus]')
  const target = canFocus(remembered)
    ? remembered
    : canFocus(autofocus)
      ? autofocus
      : tabbableElements(layer.container)[0] || layer.container
  target.focus({ preventScroll: true })
}

function onFocusIn(event) {
  const layer = topLayer()
  if (!layer) return
  if (layer.container.contains(event.target)) layer.lastFocused = event.target
  else focusInside(layer, true)
}

function onKeyDown(event) {
  const layer = topLayer()
  if (!layer || event.defaultPrevented || event.isComposing) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    layer.onEscape?.()
    return
  }
  if (event.key !== 'Tab') return
  const elements = tabbableElements(layer.container)
  const index = elements.indexOf(document.activeElement)
  if (!elements.length || index === -1 || (event.shiftKey ? index === 0 : index === elements.length - 1)) {
    event.preventDefault()
    const target = event.shiftKey ? elements.at(-1) : elements[0]
    ;(target || layer.container).focus({ preventScroll: true })
  }
}

function updateTopLayer() {
  for (const layer of layers) layer.onTopChange?.(layer === topLayer())
}

export function activateFocusLayer(container, options = {}) {
  const layer = {
    container,
    onEscape: options.onEscape,
    onTopChange: options.onTopChange,
    returnFocusTo: options.returnFocusTo || document.activeElement,
    lastFocused: null,
  }
  if (!layers.length) {
    bodyWasLocked = document.body.classList.contains('modal-open')
    document.body.classList.add('modal-open')
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('focusin', onFocusIn, true)
  }
  layers.push(layer)
  updateTopLayer()
  // Let Vue apply the active layer's inert attributes before moving focus.
  queueMicrotask(() => focusInside(layer))

  return {
    isTop: () => topLayer() === layer,
    release({ restoreFocus = true } = {}) {
      const index = layers.indexOf(layer)
      if (index === -1) return
      const wasTop = topLayer() === layer
      layers.splice(index, 1)
      layer.onTopChange?.(false)
      updateTopLayer()
      if (!layers.length) {
        document.removeEventListener('keydown', onKeyDown, true)
        document.removeEventListener('focusin', onFocusIn, true)
        if (!bodyWasLocked) document.body.classList.remove('modal-open')
      }
      if (!wasTop || !restoreFocus) return
      const nextLayer = topLayer()
      queueMicrotask(() => {
        if (topLayer() !== nextLayer) return
        if (
          canFocus(layer.returnFocusTo) &&
          (!nextLayer || nextLayer.container.contains(layer.returnFocusTo))
        ) {
          layer.returnFocusTo.focus({ preventScroll: true })
        } else if (nextLayer) {
          focusInside(nextLayer, true)
        }
      })
    },
  }
}
