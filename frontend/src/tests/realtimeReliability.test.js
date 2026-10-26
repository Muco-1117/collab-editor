import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRenderer } from 'vue'
import { useCollabSocket } from '../composables/useCollabSocket.js'
import { applyOperation, createCollabState, fieldValue } from '../collab/collabState.js'

class TestSocket {
  static OPEN = 1
  static CLOSED = 3
  static instances = []

  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    TestSocket.instances.push(this)
  }

  open() {
    this.readyState = TestSocket.OPEN
    this.onopen?.()
  }

  receive(message) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }

  send(raw) {
    if (this.failSend) {
      this.failSend = false
      throw new Error('transport failed')
    }
    this.sent.push(JSON.parse(raw))
  }

  close(code = 1006) {
    this.readyState = TestSocket.CLOSED
    this.onclose?.({ code })
  }

  get operations() {
    return this.sent.filter((frame) => frame.type === 'op').map((frame) => frame.op)
  }
}

const renderer = createRenderer({
  patchProp() {},
  insert() {},
  remove() {},
  setText() {},
  setElementText() {},
  createElement: () => ({}),
  createText: () => ({}),
  createComment: () => ({}),
  parentNode: () => null,
  nextSibling: () => null,
})

const seed = [
  {
    id: 'paragraph',
    type: 'TEXT',
    rootClock: 'seed:1',
    fields: {
      text: { value: '已保存的内容', clock: 'seed:1' },
      order: { value: 1024, clock: 'seed:1' },
      '#version': { value: 'seed-version', clock: 'seed:1' },
    },
  },
]

let apps = []
let token = 'test-session-token'
let sequence = 0

function mount() {
  let collab
  const app = renderer.createApp({
    setup() {
      collab = useCollabSocket({
        docId: `reliability-${++sequence}`,
        application: 'doc',
        initialRole: 'editor',
      })
      return () => null
    },
  })
  app.mount({})
  apps.push(app)
  return { collab, socket: TestSocket.instances.at(-1), app }
}

function welcome(socket, snapshot = seed, rev = 1, access = {}) {
  socket.open()
  socket.receive({ type: 'welcome', snapshot, rev, role: 'editor', canWrite: true, ...access })
}

function incremental(socket, fromRev, toRev, ops = [], access = {}) {
  socket.open()
  socket.receive({ type: 'incremental', fromRev, toRev, ops, role: 'editor', canWrite: true, ...access })
}

function text(collab, id = 'paragraph') {
  return fieldValue(collab.state.elements.get(id), 'text')
}

function snapshotAfter(...operations) {
  const state = createCollabState(seed)
  for (const operation of operations) applyOperation(state, operation)
  return [...state.elements.values()]
}

function nextSocket(delay = 500) {
  vi.advanceTimersByTime(delay)
  return TestSocket.instances.at(-1)
}

function jwt({ uid = 11, sub = 'same-user', exp = Math.floor(Date.now() / 1000) + 600 } = {}) {
  return `header.${btoa(JSON.stringify({ uid, sub, exp }))}.signature`
}

describe('reliable collaboration recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-22T07:30:00Z'))
    apps = []
    token = 'test-session-token'
    TestSocket.instances = []
    vi.stubGlobal('WebSocket', TestSocket)
    vi.stubGlobal('localStorage', {
      getItem: (key) => (key === 'collab_access_token' ? token : null),
      setItem() {},
      removeItem() {},
    })
    vi.stubGlobal('window', {
      location: { protocol: 'http:', host: 'localhost:5173' },
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    })
  })

  afterEach(() => {
    apps.forEach((app) => app.unmount())
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('receives authoritative metadata at join and updates titles independently of content revisions', () => {
    const { collab, socket } = mount()
    welcome(socket, seed, 3, { docId: collab.docId, kind: 'doc', title: '当前标题' })
    expect(collab.metadata.value).toEqual({ docId: collab.docId, kind: 'doc', title: '当前标题' })
    socket.receive({ type: 'metadata', docId: collab.docId, kind: 'doc', title: '共同修改的标题' })
    expect(collab.metadata.value.title).toBe('共同修改的标题')
    expect(collab.revision.value).toBe(3)
    expect(text(collab)).toBe('已保存的内容')
    socket.receive({ type: 'metadata', docId: 'another-document', kind: 'doc', title: '错误标题' })
    socket.receive({ type: 'metadata', docId: collab.docId, kind: 'board', title: '错误类型' })
    socket.receive({ type: 'metadata', docId: collab.docId, kind: 'doc', title: '' })
    expect(collab.metadata.value.title).toBe('共同修改的标题')
    socket.close()
    const next = nextSocket()
    incremental(next, 3, 3, [], { docId: collab.docId, kind: 'doc', title: '离线期间修改的标题' })
    expect(collab.metadata.value.title).toBe('离线期间修改的标题')
  })

  it('keeps unconfirmed input on disconnect and resends after an authorized incremental sync', () => {
    const { collab, socket } = mount()
    welcome(socket)
    expect(collab.putField('paragraph', 'TEXT', 'text', '断线前输入')).toBe(true)
    const operation = socket.operations[0]
    socket.close()

    expect(text(collab)).toBe('断线前输入')
    expect(collab.pendingCount.value).toBe(1)
    expect(collab.canEdit.value).toBe(false)
    expect(collab.putField('paragraph', 'TEXT', 'text', '离线输入')).toBe(false)
    const recovered = nextSocket()
    expect(recovered.operations).toEqual([])
    recovered.open()
    expect(recovered.sent[0]).toMatchObject({ type: 'hello', lastRev: 1, clientId: collab.clientId })
    expect(recovered.operations).toEqual([])
    recovered.receive({ type: 'incremental', fromRev: 1, toRev: 1, ops: [], role: 'editor', canWrite: true })

    expect(recovered.operations).toEqual([operation])
    expect(text(collab)).toBe('断线前输入')
    expect(collab.pendingCount.value).toBe(1)
    recovered.receive({ type: 'applied', rev: 2, op: operation })
    expect(collab.pendingCount.value).toBe(0)
    expect(collab.revision.value).toBe(2)
    expect(text(collab)).toBe('断线前输入')
  })

  it('retries the original identity when the server committed the write but its acknowledgement was lost', () => {
    const { collab, socket } = mount()
    welcome(socket)
    collab.putField('paragraph', 'TEXT', 'text', '服务端已经保存')
    const operation = socket.operations[0]
    socket.close()
    const recovered = nextSocket()
    incremental(recovered, 1, 2, [operation])

    expect(recovered.operations).toEqual([operation])
    expect(collab.pendingCount.value).toBe(1)
    recovered.receive({ type: 'applied', rev: 2, duplicate: true, op: operation })
    expect(collab.pendingCount.value).toBe(0)
    expect(collab.revision.value).toBe(2)
    expect(text(collab)).toBe('服务端已经保存')
    recovered.receive({ type: 'applied', rev: 2, duplicate: true, op: operation })
    expect(collab.revision.value).toBe(2)
  })

  it('merges a full welcome snapshot with pending writes without replacing the visible input with old content', () => {
    const { collab, socket } = mount()
    welcome(socket)
    collab.putField('paragraph', 'TEXT', 'text', '本地待确认')
    const operation = socket.operations[0]
    socket.close()
    const recovered = nextSocket()
    welcome(recovered)

    expect(text(collab)).toBe('本地待确认')
    expect(recovered.operations).toEqual([operation])
    recovered.receive({ type: 'applied', rev: 2, op: operation })
    expect(text(collab)).toBe('本地待确认')
    expect(collab.pendingCount.value).toBe(0)
  })

  it('resends consecutive writes in their original order and older acknowledgements cannot remove a later write', () => {
    const { collab, socket } = mount()
    welcome(socket)
    collab.putField('paragraph', 'TEXT', 'text', '第一次')
    collab.putField('paragraph', 'TEXT', 'text', '第二次')
    collab.putField('paragraph', 'TEXT', 'align', 'center')
    const operations = socket.operations
    socket.close()
    const recovered = nextSocket()
    welcome(recovered, snapshotAfter(operations[0]), 2)

    expect(recovered.operations).toEqual(operations)
    expect(text(collab)).toBe('第二次')
    expect(fieldValue(collab.state.elements.get('paragraph'), 'align')).toBe('center')
    recovered.receive({ type: 'applied', rev: 2, op: operations[0], duplicate: true })
    expect(collab.pendingCount.value).toBe(2)
    recovered.receive({ type: 'applied', rev: 2, op: operations[0], duplicate: true })
    expect(collab.pendingCount.value).toBe(2)
    expect(text(collab)).toBe('第二次')
    recovered.receive({ type: 'applied', rev: 3, op: operations[1] })
    recovered.receive({ type: 'applied', rev: 4, op: operations[2] })
    expect(collab.pendingCount.value).toBe(0)
    expect(fieldValue(collab.state.elements.get('paragraph'), 'align')).toBe('center')
  })

  it('does not acknowledge another operation solely because its clock matches', () => {
    const { collab, socket } = mount()
    welcome(socket)
    collab.putField('paragraph', 'TEXT', 'text', '待确认')
    const operation = socket.operations[0]
    socket.receive({
      type: 'applied',
      rev: 1,
      duplicate: true,
      op: { ...operation, opId: 'different-operation' },
    })
    expect(collab.pendingCount.value).toBe(1)
    expect(text(collab)).toBe('待确认')
    socket.receive({ type: 'applied', rev: 2, op: operation })
    expect(collab.pendingCount.value).toBe(0)
  })

  it('does not resurrect a remotely deleted element when a duplicate acknowledgement follows a full snapshot', () => {
    const { collab, socket } = mount()
    welcome(socket)
    collab.putField('paragraph', 'TEXT', 'text', '已被其他成员删除')
    const operation = socket.operations[0]
    socket.close()
    const recovered = nextSocket()
    welcome(recovered, [], 3)
    recovered.receive({ type: 'applied', rev: 3, duplicate: true, op: operation })

    expect(collab.pendingCount.value).toBe(0)
    expect(collab.state.elements.has('paragraph')).toBe(false)
  })

  it('does not treat a duplicate acknowledgement watermark as delivered content', () => {
    const { collab, socket } = mount()
    welcome(socket)
    collab.putField('paragraph', 'TEXT', 'text', '自己的写入')
    const operation = socket.operations[0]
    socket.close()
    const recovered = nextSocket()
    incremental(recovered, 1, 2, [operation])
    recovered.receive({ type: 'applied', rev: 4, duplicate: true, op: operation })
    expect(collab.revision.value).toBe(2)
    const remote = {
      ...operation,
      clock: 'remote:9999',
      opId: 'remote-write',
      value: { text: '随后广播的内容' },
    }
    recovered.receive({ type: 'applied', rev: 3, op: remote })
    expect(text(collab)).toBe('随后广播的内容')
    expect(collab.revision.value).toBe(3)
    recovered.close()
    const again = nextSocket()
    again.open()
    expect(again.sent[0].lastRev).toBe(3)
  })

  it('keeps remote winners when replayed local writes lose the element-state comparison', () => {
    const { collab, socket } = mount()
    welcome(socket)
    collab.putField('paragraph', 'TEXT', 'text', '本地旧写')
    const local = socket.operations[0]
    const remote = { ...local, clock: 'remote:9999', opId: 'remote-winner', value: { text: '远端新版本' } }
    socket.close()
    const recovered = nextSocket()
    incremental(recovered, 1, 2, [remote])
    expect(text(collab)).toBe('远端新版本')
    recovered.receive({ type: 'applied', rev: 3, op: local })
    expect(collab.pendingCount.value).toBe(0)
    expect(text(collab)).toBe('远端新版本')
  })

  it('respects a welcome tombstone when a previously undelivered local write is accepted as a losing STATE', () => {
    const { collab, socket } = mount()
    welcome(socket)
    collab.putField('paragraph', 'TEXT', 'text', '远端删除前尚未送达的输入')
    const operation = socket.operations[0]
    socket.close()
    const recovered = nextSocket()
    const deleted = {
      id: 'paragraph',
      type: 'TEXT',
      rootClock: 'remote:9999',
      fields: {
        text: { value: '已保存的内容', clock: 'remote:9999' },
        '#tombstone': { value: true, clock: 'remote:9999' },
        '#version': { value: 'remote-delete', clock: 'remote:9999' },
      },
    }
    welcome(recovered, [deleted], 2)
    expect(collab.state.elements.has('paragraph')).toBe(false)
    expect(collab.state.deletedElements.has('paragraph')).toBe(true)
    expect(recovered.operations).toEqual([operation])
    recovered.receive({ type: 'applied', rev: 3, op: operation })
    expect(collab.pendingCount.value).toBe(0)
    expect(collab.state.elements.has('paragraph')).toBe(false)
    expect(collab.revision.value).toBe(3)
  })

  it('keeps a newer pending edit when a previous acknowledgement arrives later on the same connection', () => {
    const { collab, socket } = mount()
    welcome(socket)
    collab.putField('paragraph', 'TEXT', 'text', '第一版')
    collab.putField('paragraph', 'TEXT', 'text', '第二版')
    const [first, second] = socket.operations
    socket.receive({ type: 'applied', rev: 3, op: second })
    expect(collab.pendingCount.value).toBe(1)
    expect(text(collab)).toBe('第二版')
    socket.receive({ type: 'applied', rev: 2, op: first })
    expect(collab.pendingCount.value).toBe(0)
    expect(text(collab)).toBe('第二版')
    socket.close()
    incremental(nextSocket(), 3, 3)
    expect(text(collab)).toBe('第二版')
  })

  it('ignores a delayed pre-snapshot acknowledgement instead of resurrecting snapshot-absent content', () => {
    const { collab, socket } = mount()
    welcome(socket)
    collab.putField('paragraph', 'TEXT', 'text', '旧确认')
    const operation = socket.operations[0]
    socket.close()
    const recovered = nextSocket()
    welcome(recovered, [], 4)
    recovered.receive({ type: 'applied', rev: 2, op: operation })
    expect(collab.pendingCount.value).toBe(0)
    expect(collab.elements.value).toEqual([])
    expect(collab.revision.value).toBe(4)
  })

  it('ignores messages and close events from an old socket even during reconnect backoff', () => {
    const { collab, socket } = mount()
    welcome(socket)
    collab.putField('paragraph', 'TEXT', 'text', '当前输入')
    const operation = socket.operations[0]
    socket.close()
    socket.receive({ type: 'applied', rev: 99, op: operation })
    socket.receive({ type: 'welcome', snapshot: [], rev: 99, role: 'viewer', canWrite: false })
    socket.close(1008)
    expect(collab.pendingCount.value).toBe(1)
    expect(collab.revision.value).toBe(1)
    expect(collab.status.value).toBe('reconnecting')
    const recovered = nextSocket()
    incremental(recovered, 1, 1)
    socket.receive({ type: 'error', fatal: true, message: '旧连接错误' })
    expect(collab.canEdit.value).toBe(true)
    expect(recovered.operations).toEqual([operation])
  })

  it('preserves earlier queued changes if sending a subsequent change throws', () => {
    const { collab, socket } = mount()
    welcome(socket)
    collab.putField('paragraph', 'TEXT', 'text', '此前发送的内容')
    const first = socket.operations[0]
    socket.failSend = true
    expect(collab.putField('paragraph', 'TEXT', 'text', '发送失败的内容')).toBe(false)
    expect(text(collab)).toBe('此前发送的内容')
    expect(collab.pendingCount.value).toBe(1)
    const recovered = nextSocket()
    incremental(recovered, 1, 1)
    expect(recovered.operations).toEqual([first])
  })

  it('reverts a rejected change to confirmed content and does not resend it after syncing again', () => {
    const { collab, socket } = mount()
    welcome(socket)
    collab.putField('paragraph', 'TEXT', 'text', '已确认的下一版')
    socket.receive({ type: 'applied', rev: 2, op: socket.operations[0] })
    collab.putField('paragraph', 'TEXT', 'text', '不合法的写入')
    socket.receive({ type: 'error', code: 'INVALID_OP', message: '修改无效', fatal: false })

    expect(text(collab)).toBe('已确认的下一版')
    expect(collab.pendingCount.value).toBe(0)
    expect(collab.canEdit.value).toBe(false)
    const recovered = nextSocket(0)
    welcome(recovered, snapshotAfter(socket.operations[0]), 2)
    expect(recovered.sent[0].lastRev).toBe(0)
    expect(recovered.operations).toEqual([])
    expect(collab.error.value).toBe('修改无效')
  })

  it('discards pending writes if reconnecting reveals a viewer role', () => {
    const { collab, socket } = mount()
    welcome(socket)
    collab.putField('paragraph', 'TEXT', 'text', '权限变化前输入')
    socket.close()
    const recovered = nextSocket()
    incremental(recovered, 1, 1, [], { role: 'viewer', canWrite: false })

    expect(recovered.operations).toEqual([])
    expect(text(collab)).toBe('已保存的内容')
    expect(collab.pendingCount.value).toBe(0)
    expect(collab.canEdit.value).toBe(false)
    expect(collab.error.value).toContain('编辑权限已变更')
  })

  it('handles a read-only rejection without allowing further writes before the new permissions arrive', () => {
    const { collab, socket } = mount()
    welcome(socket)
    collab.putField('paragraph', 'TEXT', 'text', '未授权写入')
    socket.receive({ type: 'error', code: 'READ_ONLY', message: '只读成员不可编辑', fatal: false })
    expect(collab.canEdit.value).toBe(false)
    expect(collab.pendingCount.value).toBe(0)
    expect(text(collab)).toBe('已保存的内容')
    const recovered = nextSocket(0)
    welcome(recovered, seed, 1, { role: 'viewer', canWrite: false })
    expect(recovered.operations).toEqual([])
    expect(collab.canEdit.value).toBe(false)
  })

  it('stops after fatal errors and removes content when document access is revoked', () => {
    const { collab, socket } = mount()
    welcome(socket)
    collab.putField('paragraph', 'TEXT', 'text', '待确认')
    socket.receive({ type: 'error', code: 'MEMBERSHIP_REVOKED', message: '已移出空间', fatal: true })
    expect(collab.status.value).toBe('closed')
    expect(collab.elements.value).toEqual([])
    expect(collab.pendingCount.value).toBe(0)
    expect(collab.retryAllowed.value).toBe(false)
    expect(collab.retry()).toBe(false)
    vi.advanceTimersByTime(120000)
    expect(TestSocket.instances).toHaveLength(1)
  })

  it('updates editing permissions immediately when the server announces an access change', () => {
    const { collab, socket } = mount()
    welcome(socket)
    socket.receive({ type: 'access', role: 'viewer', canWrite: false, message: '你的角色已变更为只读者' })
    expect(collab.canEdit.value).toBe(false)
    expect(collab.role.value).toBe('viewer')
    expect(text(collab)).toBe('已保存的内容')
    expect(collab.connected.value).toBe(true)
    socket.receive({ type: 'access', role: 'editor', canWrite: true })
    expect(collab.canEdit.value).toBe(true)
    expect(collab.role.value).toBe('editor')
  })

  it('allows manual retry after a transient server failure but does not retry automatically', () => {
    const { collab, socket } = mount()
    socket.open()
    socket.receive({ type: 'error', code: 'SERVER_ERROR', message: '服务暂时不可用', fatal: true })
    expect(collab.status.value).toBe('closed')
    expect(collab.retryAllowed.value).toBe(true)
    vi.advanceTimersByTime(120000)
    expect(TestSocket.instances).toHaveLength(1)
    expect(collab.retry()).toBe(true)
    welcome(nextSocket(0))
    expect(collab.canEdit.value).toBe(true)
  })

  it('rolls back pending input and fetches confirmed content when access is downgraded during a write', () => {
    const { collab, socket } = mount()
    welcome(socket)
    collab.putField('paragraph', 'TEXT', 'text', '待确认修改')
    socket.receive({ type: 'access', role: 'viewer', canWrite: false, message: '你的角色已变更为只读者' })
    expect(collab.canEdit.value).toBe(false)
    expect(collab.pendingCount.value).toBe(0)
    expect(text(collab)).toBe('已保存的内容')
    const recovered = nextSocket(0)
    welcome(recovered, seed, 1, { role: 'viewer', canWrite: false })
    expect(recovered.operations).toEqual([])
    expect(recovered.sent[0].lastRev).toBe(0)
  })

  it('keeps history restoration authoritative by explicitly discarding the previous pending queue', () => {
    const { collab, socket } = mount()
    welcome(socket)
    collab.putField('paragraph', 'TEXT', 'text', '恢复前的未确认写入')
    const old = socket.operations[0]
    collab.reloadSnapshot()
    expect(collab.pendingCount.value).toBe(0)
    socket.receive({ type: 'applied', rev: 2, op: old })
    const recovered = nextSocket(0)
    welcome(recovered, [], 3)
    expect(recovered.sent[0].lastRev).toBe(0)
    expect(recovered.operations).toEqual([])
    expect(collab.elements.value).toEqual([])
  })

  it('only sends pending operations after a valid sync grants write permissions', () => {
    const { collab, socket } = mount()
    welcome(socket)
    collab.putField('paragraph', 'TEXT', 'text', '未确认')
    socket.close()
    const recovered = nextSocket()
    recovered.open()
    recovered.receive({ type: 'welcome', rev: 1, snapshot: seed })
    expect(collab.canEdit.value).toBe(false)
    expect(recovered.operations).toEqual([])
    expect(collab.pendingCount.value).toBe(1)
    const good = nextSocket(1000)
    welcome(good)
    expect(good.operations).toEqual(socket.operations)
  })

  it('rejects a mismatched incremental cursor and requests a full snapshot', () => {
    const { collab, socket } = mount()
    welcome(socket)
    collab.putField('paragraph', 'TEXT', 'text', '未确认')
    socket.close()
    const recovered = nextSocket()
    incremental(recovered, 7, 7)
    expect(recovered.operations).toEqual([])
    expect(collab.pendingCount.value).toBe(1)
    const full = nextSocket(1000)
    full.open()
    expect(full.sent[0].lastRev).toBe(0)
    full.receive({ type: 'welcome', rev: 1, snapshot: seed, role: 'editor', canWrite: true })
    expect(full.operations).toEqual(socket.operations)
  })

  it('recovers from malformed frames without dropping pending changes', () => {
    const { collab, socket } = mount()
    welcome(socket)
    collab.putField('paragraph', 'TEXT', 'text', '保留输入')
    socket.onmessage({ data: 'not JSON' })
    expect(collab.status.value).toBe('reconnecting')
    expect(collab.pendingCount.value).toBe(1)
    expect(text(collab)).toBe('保留输入')
    const recovered = nextSocket()
    welcome(recovered)
    expect(recovered.sent[0].lastRev).toBe(0)
    expect(recovered.operations).toEqual(socket.operations)
  })

  it('reconnects on missing acknowledgements even when the server still responds to heartbeat pings', () => {
    const { collab, socket } = mount()
    welcome(socket)
    collab.putField('paragraph', 'TEXT', 'text', '尚未确认')
    vi.advanceTimersByTime(15000)
    socket.receive({ type: 'pong' })
    vi.advanceTimersByTime(15000)
    expect(collab.status.value).toBe('reconnecting')
    expect(collab.error.value).toContain('修改尚未收到确认')
    expect(collab.pendingCount.value).toBe(1)
    const recovered = nextSocket()
    incremental(recovered, 1, 1)
    expect(recovered.operations).toEqual(socket.operations)
  })

  it('keeps confirmed content and disables edits when the heartbeat expires', () => {
    const { collab, socket } = mount()
    welcome(socket)
    vi.advanceTimersByTime(45000)
    expect(collab.status.value).toBe('reconnecting')
    expect(collab.canEdit.value).toBe(false)
    expect(collab.error.value).toContain('心跳超时')
    expect(text(collab)).toBe('已保存的内容')
  })

  it('times out a socket that opens but never completes initial synchronization', () => {
    const { collab, socket } = mount()
    socket.open()
    socket.receive({ type: 'pong' })
    vi.advanceTimersByTime(20000)
    expect(collab.status.value).toBe('reconnecting')
    expect(collab.canEdit.value).toBe(false)
    expect(collab.error.value).toContain('等待协同连接超时')
    nextSocket()
    expect(TestSocket.instances).toHaveLength(2)
  })

  it('bounds repeated opaque handshake failures and permits a deliberate manual retry', () => {
    const { collab } = mount()
    for (let index = 0; index < 10; index += 1) {
      TestSocket.instances.at(-1).close()
      if (index < 9) vi.advanceTimersByTime(Math.min(10000, 500 * 2 ** index))
    }
    expect(collab.status.value).toBe('closed')
    expect(TestSocket.instances).toHaveLength(10)
    vi.advanceTimersByTime(60000)
    expect(TestSocket.instances).toHaveLength(10)
    expect(collab.retry()).toBe(true)
    const retry = nextSocket(0)
    welcome(retry)
    expect(collab.canEdit.value).toBe(true)
  })

  it('bounds automatic write retransmissions while retaining unsaved content for manual retry', () => {
    const { collab, socket } = mount()
    welcome(socket)
    collab.putField('paragraph', 'TEXT', 'text', '保留待确认修改')
    const operation = socket.operations[0]
    for (let index = 0; index < 4; index += 1) {
      TestSocket.instances.at(-1).close()
      incremental(nextSocket(), 1, 1)
    }
    expect(collab.status.value).toBe('closed')
    expect(collab.pendingCount.value).toBe(1)
    expect(text(collab)).toBe('保留待确认修改')
    expect(TestSocket.instances.reduce((count, item) => count + item.operations.length, 0)).toBe(4)
    expect(collab.retry()).toBe(true)
    const recovered = nextSocket(0)
    incremental(recovered, 1, 1)
    expect(recovered.operations).toEqual([operation])
    recovered.receive({ type: 'applied', rev: 2, op: operation })
    expect(collab.pendingCount.value).toBe(0)
  })

  it('stops retrying an expired JWT without discarding pending input', () => {
    token = jwt({ exp: Math.floor(Date.now() / 1000) + 1 })
    const { collab, socket } = mount()
    welcome(socket)
    collab.putField('paragraph', 'TEXT', 'text', '登录过期前输入')
    vi.advanceTimersByTime(2000)
    socket.close()
    nextSocket()
    expect(collab.status.value).toBe('closed')
    expect(collab.error.value).toContain('登录已过期')
    expect(collab.pendingCount.value).toBe(1)
    expect(text(collab)).toBe('登录过期前输入')
    expect(TestSocket.instances).toHaveLength(1)
  })

  it('allows a refreshed token for the same user and never replays pending writes under another account', () => {
    token = jwt()
    const { collab, socket } = mount()
    welcome(socket)
    collab.putField('paragraph', 'TEXT', 'text', '属于原用户')
    token = jwt({ exp: Math.floor(Date.now() / 1000) + 1200 })
    socket.close()
    const refreshed = nextSocket()
    incremental(refreshed, 1, 1)
    expect(refreshed.operations).toEqual(socket.operations)
    token = jwt({ uid: 22, sub: 'another-user' })
    refreshed.close()
    nextSocket()
    expect(collab.status.value).toBe('closed')
    expect(collab.pendingCount.value).toBe(0)
    expect(collab.elements.value).toEqual([])
    expect(TestSocket.instances).toHaveLength(2)
  })

  it('checks account identity again before accepting a delayed handshake', () => {
    token = jwt()
    const { collab, socket } = mount()
    welcome(socket)
    collab.putField('paragraph', 'TEXT', 'text', '属于原用户')
    socket.close()
    const recovered = nextSocket()
    recovered.open()
    token = jwt({ uid: 22, sub: 'another-user' })
    recovered.receive({ type: 'welcome', snapshot: seed, rev: 1, role: 'editor', canWrite: true })
    expect(collab.status.value).toBe('closed')
    expect(collab.retryAllowed.value).toBe(false)
    expect(collab.pendingCount.value).toBe(0)
    expect(recovered.operations).toEqual([])
  })

  it('stops immediately when the server closes for a policy violation', () => {
    const { collab, socket } = mount()
    welcome(socket)
    socket.close(1008)
    expect(collab.status.value).toBe('closed')
    vi.advanceTimersByTime(60000)
    expect(TestSocket.instances).toHaveLength(1)
  })

  it('does not change a retried operation payload when its original input object is later mutated', () => {
    const { collab, socket } = mount()
    welcome(socket)
    const value = { text: '发送时内容', order: 1024 }
    collab.setElement('paragraph', 'TEXT', value)
    value.text = '发送后变更'
    socket.close()
    const recovered = nextSocket()
    welcome(recovered)
    expect(recovered.operations).toEqual(socket.operations)
    expect(text(collab)).toBe('发送时内容')
  })
})
