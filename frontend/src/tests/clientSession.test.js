import { describe, expect, it } from 'vitest'
import { createClientSession, pageClientId } from '../collab/clientSession.js'

describe('page collaboration session', () => {
  it('keeps one client id for the page module lifecycle', () => {
    expect(pageClientId()).toBe(pageClientId())
  })

  it('continues a document clock when the document is reopened', () => {
    const session = createClientSession('page-client')
    const firstVisit = session.clockFor('doc-a')
    expect(firstVisit.tick()).toBe('page-client:1')
    firstVisit.observe('remote:8')

    const reopened = session.clockFor('doc-a')
    expect(reopened).toBe(firstVisit)
    expect(reopened.tick()).toBe('page-client:10')
  })

  it('keeps counters independent between documents', () => {
    const session = createClientSession('page-client')
    expect(session.clockFor('doc-a').tick()).toBe('page-client:1')
    expect(session.clockFor('doc-b').tick()).toBe('page-client:1')
  })
})
