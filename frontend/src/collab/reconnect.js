export function reconnectDelay(attempt, base = 500, maximum = 10000) {
  const safeAttempt = Math.max(0, Math.floor(Number(attempt) || 0))
  return Math.min(maximum, base * (2 ** safeAttempt))
}

export function advanceRevision(current, message = {}) {
  const now = Math.max(0, Number(current) || 0)
  if (message.type === 'welcome' || message.type === 'applied') {
    return Math.max(now, Number(message.rev) || 0)
  }
  if (message.type === 'incremental') {
    const explicit = Number(message.toRev ?? message.rev)
    if (Number.isFinite(explicit)) return Math.max(now, explicit)
    const from = Math.max(now, Number(message.fromRev) || 0)
    return from + (Array.isArray(message.ops) ? message.ops.length : 0)
  }
  return now
}
