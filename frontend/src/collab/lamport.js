export function parseClock(encoded) {
  if (typeof encoded !== 'string') return { replicaId: '', counter: 0 }
  const separator = encoded.lastIndexOf(':')
  if (separator <= 0) return { replicaId: '', counter: 0 }
  const counter = Number(encoded.slice(separator + 1))
  return {
    replicaId: encoded.slice(0, separator),
    counter: Number.isSafeInteger(counter) && counter >= 0 ? counter : 0,
  }
}

export function formatClock(replicaId, counter) {
  if (!replicaId || replicaId.includes(':')) throw new Error('replicaId 不能为空且不能包含冒号')
  if (!Number.isSafeInteger(counter) || counter < 1) throw new Error('Lamport counter 必须为正整数')
  return `${replicaId}:${counter}`
}

export function compareClocks(left, right) {
  const a = parseClock(left)
  const b = parseClock(right)
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1
  if (a.replicaId === b.replicaId) return 0
  return a.replicaId < b.replicaId ? -1 : 1
}

export function tick(counter, replicaId) {
  const next = Math.max(0, Number(counter) || 0) + 1
  return { counter: next, clock: formatClock(replicaId, next) }
}

export function observe(counter, remoteClock) {
  return Math.max(Math.max(0, Number(counter) || 0), parseClock(remoteClock).counter) + 1
}

export function createLamport(replicaId, initialCounter = 0) {
  let counter = Math.max(0, Number(initialCounter) || 0)
  return {
    tick() {
      const result = tick(counter, replicaId)
      counter = result.counter
      return result.clock
    },
    observe(remoteClock) {
      counter = observe(counter, remoteClock)
      return counter
    },
    get counter() {
      return counter
    },
  }
}
