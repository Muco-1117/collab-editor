import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRenderer } from 'vue'
import { useCollabSocket } from '../composables/useCollabSocket.js'
import { fieldValue } from '../collab/collabState.js'

class FakeWebSocket {
  static OPEN = 1
  static CLOSED = 3
  static instances = []

  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    FakeWebSocket.instances.push(this)
  }

  open() {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  receive(message) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }

  send(payload) {
    if (this.failNextSend) {
      this.failNextSend = false
      throw new Error('send failed')
    }
    this.sent.push(JSON.parse(payload))
  }

  close(code = 1000) {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code })
  }
}

const renderer = createRenderer({
  patchProp() {},
  insert() {},
  remove() {},
  createElement: () => ({}),
  createText: () => ({}),
  createComment: () => ({}),
  setText() {},
  setElementText() {},
  parentNode: () => null,
  nextSibling: () => null,
})

function mountCollab(docId) {
  let collab
  const app = renderer.createApp({
    setup() {
      collab = useCollabSocket({ docId, application: 'doc', initialRole: 'editor' })
      return () => null
    },
  })
  app.mount({})
  return { app, collab, socket: FakeWebSocket.instances.at(-1) }
}

function welcome(socket, snapshot = []) {
  socket.open()
  socket.receive({ type: 'welcome', rev: 1, role: 'editor', canWrite: true, snapshot })
}

describe('collaboration socket optimistic state', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('localStorage', {
      getItem: (key) => (key === 'collab_access_token' ? 'test-token' : null),
      setItem() {},
      removeItem() {},
    })
    vi.stubGlobal('window', {
      location: { protocol: 'http:', host: 'localhost:5173' },
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
      setInterval: vi.fn(() => 2),
      clearInterval: vi.fn(),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('supports consecutive ADD and PUT operations and keeps them after acknowledgements', () => {
    const { app, collab, socket } = mountCollab('socket-add-put')
    welcome(socket)

    expect(collab.addElement('p-new', 'TEXT')).toBe(true)
    expect(collab.putField('p-new', 'TEXT', 'order', 1024)).toBe(true)
    expect(collab.putField('p-new', 'TEXT', 'text', 'new paragraph')).toBe(true)
    expect(fieldValue(collab.state.elements.get('p-new'), 'text')).toBe('new paragraph')
    expect(collab.pendingCount.value).toBe(3)

    const operations = socket.sent.filter((frame) => frame.type === 'op').map((frame) => frame.op)
    operations.forEach((op, index) => socket.receive({ type: 'applied', rev: index + 2, op }))
    expect(collab.pendingCount.value).toBe(0)
    socket.close(1006)

    expect(collab.state.elements.has('p-new')).toBe(true)
    expect(collab.revision.value).toBe(4)
    app.unmount()
  })

  it('preserves unconfirmed optimistic state and the confirmed revision when the connection closes', () => {
    const { app, collab, socket } = mountCollab('socket-disconnect')
    welcome(socket)

    expect(collab.addElement('p-pending', 'TEXT')).toBe(true)
    socket.receive({ type: 'presence', members: [{ clientId: 'peer-a', displayName: '协作者' }] })
    expect(collab.state.elements.has('p-pending')).toBe(true)
    expect(collab.pendingCount.value).toBe(1)
    expect(collab.members.value).toHaveLength(1)
    socket.close(1006)

    expect(collab.state.elements.has('p-pending')).toBe(true)
    expect(collab.revision.value).toBe(1)
    expect(collab.pendingCount.value).toBe(1)
    expect(collab.members.value).toEqual([])
    expect(collab.status.value).toBe('reconnecting')
    app.unmount()
  })

  it('keeps an earlier sent ADD when a consecutive PUT cannot be sent', () => {
    const { app, collab, socket } = mountCollab('socket-partial-create')
    welcome(socket)

    expect(collab.addElement('p-partial', 'TEXT')).toBe(true)
    socket.failNextSend = true
    expect(collab.putField('p-partial', 'TEXT', 'text', 'not sent')).toBe(false)

    expect(collab.state.elements.has('p-partial')).toBe(true)
    expect(fieldValue(collab.state.elements.get('p-partial'), 'text', '')).toBe('')
    expect(collab.pendingCount.value).toBe(1)
    expect(collab.revision.value).toBe(1)
    expect(collab.status.value).toBe('reconnecting')
    app.unmount()
  })

  it('rolls back to confirmed content and requests a full snapshot after rejection', () => {
    const snapshot = [
      {
        id: 'p-existing',
        type: 'TEXT',
        rootClock: 'seed:1',
        fields: { text: { value: 'server', clock: 'seed:2' } },
      },
    ]
    const { app, collab, socket } = mountCollab('socket-rejected')
    welcome(socket, snapshot)

    expect(collab.putField('p-existing', 'TEXT', 'text', 'optimistic')).toBe(true)
    socket.receive({ type: 'error', code: 'STALE_OP', message: '操作未应用', fatal: false })

    expect(collab.state.elements.size).toBe(1)
    expect(fieldValue(collab.state.elements.get('p-existing'), 'text')).toBe('server')
    expect(collab.pendingCount.value).toBe(0)
    expect(collab.revision.value).toBe(0)
    expect(collab.status.value).toBe('reconnecting')
    expect(window.setTimeout).toHaveBeenCalled()
    app.unmount()
  })
})
