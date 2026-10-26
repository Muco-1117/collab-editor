import { createLamport } from './lamport.js'

export function createClientSession(clientId) {
  if (!clientId) throw new Error('clientId 不能为空')
  const clocksByDocument = new Map()

  return {
    clientId,
    clockFor(documentId) {
      const key = String(documentId || '')
      if (!key) throw new Error('documentId 不能为空')
      if (!clocksByDocument.has(key)) {
        clocksByDocument.set(key, createLamport(clientId))
      }
      return clocksByDocument.get(key)
    },
  }
}

const pageSession = createClientSession(crypto.randomUUID())

export function pageClientId() {
  return pageSession.clientId
}

export function documentClock(documentId) {
  return pageSession.clockFor(documentId)
}
