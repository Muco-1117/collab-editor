import { reactive } from 'vue'

export const toasts = reactive([])
const timers = new Map()
const MAX_VISIBLE = 3

function schedule(id) {
  const timing = timers.get(id)
  if (!timing || timing.pauses.size) return
  timing.startedAt = Date.now()
  timing.timeout = window.setTimeout(() => dismiss(id), timing.remaining)
}

function resetTimer(id, duration) {
  const timing = timers.get(id) || { pauses: new Set() }
  window.clearTimeout(timing.timeout)
  timing.remaining = duration
  timers.set(id, timing)
  schedule(id)
}

export function notify(message, type = 'info', duration = 3200) {
  const text = String(message ?? '').trim()
  if (!text) return null
  const category = ['success', 'error', 'info'].includes(type) ? type : 'info'
  const lifetime = Number.isFinite(duration) && duration > 0 ? duration : 3200
  const existing = toasts.find((toast) => toast.message === text && toast.type === category)
  if (existing) {
    resetTimer(existing.id, lifetime)
    return existing.id
  }
  while (toasts.length >= MAX_VISIBLE) dismiss(toasts[0].id)
  const id = `${Date.now()}-${Math.random()}`
  toasts.push({ id, message: text, type: category })
  resetTimer(id, lifetime)
  return id
}

export function pauseToast(id, reason = 'hover') {
  const timing = timers.get(id)
  if (!timing || timing.pauses.has(reason)) return
  if (!timing.pauses.size) {
    window.clearTimeout(timing.timeout)
    timing.remaining = Math.max(0, timing.remaining - (Date.now() - timing.startedAt))
  }
  timing.pauses.add(reason)
}

export function resumeToast(id, reason = 'hover') {
  const timing = timers.get(id)
  if (!timing || !timing.pauses.delete(reason)) return
  if (!timing.pauses.size) schedule(id)
}

export function dismiss(id) {
  const timing = timers.get(id)
  if (timing) window.clearTimeout(timing.timeout)
  timers.delete(id)
  const index = toasts.findIndex((item) => item.id === id)
  if (index >= 0) toasts.splice(index, 1)
}
