import { computed, onBeforeUnmount, readonly, ref, shallowRef } from 'vue'
import { getToken } from '../lib/apiClient.js'
import { documentClock, pageClientId } from '../collab/clientSession.js'
import {
  applyOperation,
  createCollabState,
  latestClockInSnapshot,
  loadSnapshot,
  visibleElements,
} from '../collab/collabState.js'
import { advanceRevision, reconnectDelay } from '../collab/reconnect.js'

const HEARTBEAT_INTERVAL = 15000
const HEARTBEAT_TIMEOUT = 36000
const JOIN_TIMEOUT = 20000
const ACK_TIMEOUT = 30000
const MAX_JOIN_FAILURES = 10
const MAX_SEND_ATTEMPTS = 4
const MEMBER_ROLES = new Set(['owner', 'admin', 'editor', 'viewer'])
const TERMINAL_CLOSE_CODES = new Set([1002, 1003, 1007, 1008, 1009, 1010, 4003])
const REVOKED_ACCESS_CODES = new Set([
  'MEMBERSHIP_REVOKED',
  'DOCUMENT_DELETED',
  'DOCUMENT_NOT_FOUND',
  'DOC_ACCESS_DENIED',
  'FORBIDDEN',
  'AUTH_REQUIRED',
  'CLIENT_ID_IN_USE',
])

function tokenClaims(token) {
  try {
    const encoded = token.split('.')[1]?.replace(/-/g, '+').replace(/_/g, '/')
    return encoded ? JSON.parse(atob(encoded)) : null
  } catch {
    return null
  }
}

function tokenOwner(token) {
  const claims = tokenClaims(token)
  return claims?.uid != null && claims?.sub ? `${claims.uid}:${claims.sub}` : token
}

function websocketUrl(token) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws/collab?token=${encodeURIComponent(token)}`
}

export function useCollabSocket({ docId, application, initialRole = 'viewer' }) {
  const clientId = pageClientId()
  const clock = documentClock(docId)
  const owner = tokenOwner(getToken())
  // Keep the server state separate: rejecting one optimistic write must not
  // erase confirmed content or make a duplicate acknowledgement resurrect it.
  const confirmedState = createCollabState()
  const state = createCollabState()
  const stateVersion = ref(0)
  const status = ref('connecting')
  const role = ref(MEMBER_ROLES.has(initialRole) ? initialRole : 'viewer')
  const serverCanWrite = ref(false)
  const revision = ref(0)
  const members = ref([])
  const metadata = ref(null)
  const pendingCount = ref(0)
  const error = ref('')
  const retryAllowed = ref(true)
  const socket = shallowRef(null)

  let active = true
  let manualClose = false
  let joined = false
  let joinRevision = 0
  let synchronizedRevision = 0
  let joinFailures = 0
  let reconnectAttempt = 0
  let reconnectTimer = null
  let heartbeatTimer = null
  let joinTimer = null
  let lastPongAt = Date.now()
  let connectionGeneration = 0
  let syncNotice = ''
  const pending = new Map()

  const connected = computed(() => status.value === 'connected')
  const canEdit = computed(() => connected.value && serverCanWrite.value && role.value !== 'viewer')
  const elements = computed(() => {
    stateVersion.value
    return visibleElements(state)
  })

  function bump() {
    stateVersion.value += 1
  }

  function rebuildOptimisticState() {
    loadSnapshot(state, [...confirmedState.elements.values(), ...confirmedState.deletedElements.values()])
    for (const { operation } of pending.values()) applyOperation(state, operation)
    bump()
  }

  function clearPending() {
    pending.clear()
    pendingCount.value = 0
  }

  function acknowledgePending(operation, operationId) {
    const entry = pending.get(operation?.clock)
    if (
      !entry ||
      entry.operation.opId !== (operation.opId || operationId) ||
      entry.operation.elementId !== operation.elementId
    )
      return false
    pending.delete(operation.clock)
    pendingCount.value = pending.size
    return true
  }

  function clearTimers() {
    window.clearTimeout(reconnectTimer)
    window.clearTimeout(joinTimer)
    window.clearInterval(heartbeatTimer)
    reconnectTimer = null
    joinTimer = null
    heartbeatTimer = null
  }

  function detachSocket(code = 4001, reason = 'resynchronize') {
    const previous = socket.value
    // Invalidate callbacks immediately, including the delay before a new socket
    // exists. A late frame from the closed connection is no longer authoritative.
    connectionGeneration += 1
    socket.value = null
    joined = false
    serverCanWrite.value = false
    members.value = []
    clearTimers()
    if (previous && previous.readyState !== WebSocket.CLOSED) {
      try {
        previous.close(code, reason)
      } catch {
        /* The browser may already be closing. */
      }
    }
  }

  function stopConnection(message, { discardPending = false, clearContent = false, allowRetry = true } = {}) {
    manualClose = true
    retryAllowed.value = allowRetry
    detachSocket(4003, 'connection stopped')
    if (discardPending) clearPending()
    if (clearContent) {
      loadSnapshot(confirmedState, [])
      revision.value = 0
    }
    if (discardPending || clearContent) rebuildOptimisticState()
    error.value = message
    status.value = 'closed'
  }

  function credentialsAreCurrent() {
    const token = getToken()
    if (!token) {
      stopConnection('登录状态已失效，请重新登录后再连接')
      return false
    }
    if (tokenOwner(token) !== owner) {
      stopConnection('登录用户已变更，请重新打开此内容', {
        discardPending: true,
        clearContent: true,
        allowRetry: false,
      })
      return false
    }
    // This is only a retry/UX check. The server still verifies every handshake.
    const expiresAt = Number(tokenClaims(token)?.exp)
    if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt * 1000 <= Date.now()) {
      stopConnection('登录已过期，请重新登录；尚未确认的修改仍保留在当前页面')
      return false
    }
    return true
  }

  function sendFrame(frame) {
    if (socket.value?.readyState !== WebSocket.OPEN) return false
    try {
      socket.value.send(JSON.stringify(frame))
      return true
    } catch {
      return false
    }
  }

  function scheduleReconnect(immediate = false) {
    if (!active || manualClose) return
    if (joinFailures >= MAX_JOIN_FAILURES) {
      stopConnection('暂时无法建立协同连接，请检查网络后重试；未确认的修改仍保留在当前页面')
      return
    }
    status.value = 'reconnecting'
    const delay = immediate ? 0 : reconnectDelay(reconnectAttempt++)
    reconnectTimer = window.setTimeout(connect, delay)
  }

  function recoverConnection(message, { fullSnapshot = false, immediate = false } = {}) {
    if (!active || manualClose) return
    if (!joined) joinFailures += 1
    detachSocket()
    if (fullSnapshot) revision.value = 0
    if (message) error.value = message
    scheduleReconnect(immediate)
  }

  function beginHeartbeat() {
    lastPongAt = Date.now()
    window.clearInterval(heartbeatTimer)
    heartbeatTimer = window.setInterval(() => {
      if (!credentialsAreCurrent()) return
      if (Date.now() - lastPongAt > HEARTBEAT_TIMEOUT) {
        recoverConnection('连接心跳超时，正在重新连接')
        return
      }
      const oldest = pending.values().next().value
      if (joined && oldest && Date.now() - oldest.sentAt >= ACK_TIMEOUT) {
        recoverConnection('修改尚未收到确认，正在重新连接并同步')
        return
      }
      if (!sendFrame({ type: 'ping', ts: Date.now() })) recoverConnection('连接已断开，正在重新连接')
    }, HEARTBEAT_INTERVAL)
  }

  function observeSnapshot(snapshot) {
    const maximum = latestClockInSnapshot(snapshot)
    if (maximum) clock.observe(maximum)
  }

  function applyConfirmed(operation) {
    if (!operation) return false
    clock.observe(operation.clock)
    applyOperation(confirmedState, operation)
    return applyOperation(state, operation)
  }

  function sendPending(entry) {
    if (entry.attempts >= MAX_SEND_ATTEMPTS) {
      stopConnection('修改多次未获确认，已暂停自动重试；内容仍在当前页面，请手动重试')
      return false
    }
    entry.sentAt = Date.now()
    entry.attempts += 1
    const sent = sendFrame({
      type: 'op',
      docId,
      clientId,
      baseRev: revision.value,
      op: entry.operation,
    })
    if (!sent) recoverConnection('连接已断开，修改将在恢复连接后继续同步')
    return sent
  }

  function finishSync(message) {
    synchronizedRevision = revision.value
    role.value = message.role
    serverCanWrite.value = message.canWrite ?? role.value !== 'viewer'
    if (!serverCanWrite.value || role.value === 'viewer') {
      if (pending.size) {
        clearPending()
        syncNotice = '编辑权限已变更，未确认的修改没有继续发送，已显示服务器内容'
      }
    }
    rebuildOptimisticState()
    joined = true
    window.clearTimeout(joinTimer)
    joinTimer = null
    status.value = 'connected'
    error.value = syncNotice
    reconnectAttempt = 0
    joinFailures = 0
    if (serverCanWrite.value && role.value !== 'viewer') {
      // Map insertion order preserves this replica's clock ordering. Never
      // allocate a new clock/opId: a lost acknowledgement must stay idempotent.
      for (const entry of pending.values()) {
        if (!sendPending(entry)) break
      }
    }
  }

  function validSync(message) {
    if (joined || !MEMBER_ROLES.has(message.role)) return false
    if (message.docId != null && message.docId !== docId) return false
    if (message.clientId != null && message.clientId !== clientId) return false
    if (message.canWrite != null && typeof message.canWrite !== 'boolean') return false
    const nextRevision = message.type === 'welcome' ? message.rev : (message.toRev ?? message.rev)
    if (!Number.isSafeInteger(nextRevision) || nextRevision < 0) return false
    if (message.type === 'welcome') return Array.isArray(message.snapshot ?? message.elements)
    return (
      Array.isArray(message.ops) &&
      nextRevision >= joinRevision &&
      (message.fromRev == null || message.fromRev === joinRevision)
    )
  }

  function updateMetadata(message) {
    if (
      message.docId !== docId ||
      message.kind !== application ||
      typeof message.title !== 'string' ||
      !message.title.trim() ||
      message.title.length > 256
    )
      return
    metadata.value = { docId, kind: application, title: message.title }
  }

  function handleMessage(event) {
    let message
    try {
      message = JSON.parse(event.data)
      if (!message || typeof message !== 'object' || Array.isArray(message))
        throw new Error('invalid message')
    } catch {
      recoverConnection('收到无法解析的协同消息，正在重新同步', { fullSnapshot: true })
      return
    }

    if (message.type === 'welcome' || message.type === 'incremental') {
      if (!credentialsAreCurrent()) return
      if (!validSync(message)) {
        recoverConnection('初始同步信息不完整，正在重新连接', { fullSnapshot: true })
        return
      }
      if (message.type === 'welcome') {
        const snapshot = message.snapshot ?? message.elements
        observeSnapshot(snapshot)
        loadSnapshot(confirmedState, snapshot)
        revision.value = message.rev
      } else {
        for (const operation of message.ops) {
          clock.observe(operation.clock)
          applyOperation(confirmedState, operation)
        }
        revision.value = advanceRevision(revision.value, message)
      }
      updateMetadata(message)
      finishSync(message)
      return
    }
    if (message.type === 'metadata' && joined) {
      updateMetadata(message)
      return
    }
    if (message.type === 'applied' && joined) {
      const acknowledged = acknowledgePending(message.op, message.opId)
      // Duplicate acknowledgements carry the original operation and the room's
      // current rev, not a new state change. Reapplying one after a full snapshot
      // could resurrect an element that another client has since deleted.
      const alreadyKnown = message.duplicate || message.ignored || Number(message.rev) <= synchronizedRevision
      if (!alreadyKnown && applyConfirmed(message.op)) bump()
      if (acknowledged && alreadyKnown) rebuildOptimisticState()
      // A duplicate's rev is a room watermark, not proof that its intervening
      // operations were delivered. Only actual changes advance our sync cursor.
      if (!message.duplicate && !message.ignored) revision.value = advanceRevision(revision.value, message)
      return
    }
    if (message.type === 'access' && joined && MEMBER_ROLES.has(message.role)) {
      role.value = message.role
      serverCanWrite.value = message.canWrite === true && role.value !== 'viewer'
      if (!serverCanWrite.value && pending.size) {
        clearPending()
        rebuildOptimisticState()
        syncNotice = message.message || '编辑权限已变更，未确认的修改没有继续发送'
        recoverConnection(syncNotice, { fullSnapshot: true, immediate: true })
      } else {
        syncNotice = message.message || ''
        error.value = syncNotice
      }
      return
    }
    if (message.type === 'presence' && joined) {
      members.value =
        Array.isArray(message.members) && message.members.length
          ? message.members
          : (message.clients || []).map((id) => ({ clientId: id, displayName: '在线成员' }))
      return
    }
    if (message.type === 'pong') {
      lastPongAt = Date.now()
      return
    }
    if (message.type === 'error') {
      const messageText = message.message || '协同服务返回错误'
      error.value = messageText
      const permissionError =
        ['READ_ONLY', 'MEMBERSHIP_REVOKED', 'FORBIDDEN'].includes(message.code) ||
        /只读|无权|权限|成员/.test(messageText)
      if (permissionError) serverCanWrite.value = false
      if (message.fatal) {
        stopConnection(messageText, {
          discardPending: true,
          clearContent: true,
          allowRetry: !REVOKED_ACCESS_CODES.has(message.code),
        })
        return
      }
      if (pending.size || permissionError) {
        // Error frames do not identify the rejected operation. Drop the current
        // queue, roll back to confirmed state and fetch authoritative content;
        // retrying a validation/permission error would loop forever.
        clearPending()
        rebuildOptimisticState()
        syncNotice = messageText
        recoverConnection(messageText, { fullSnapshot: true, immediate: true })
      }
    }
  }

  function connect() {
    if (!active || manualClose) return
    clearTimers()
    if (!credentialsAreCurrent()) return
    status.value = reconnectAttempt ? 'reconnecting' : 'connecting'
    const generation = ++connectionGeneration
    let ws
    try {
      ws = new WebSocket(websocketUrl(getToken()))
    } catch {
      joinFailures += 1
      error.value = '暂时无法建立实时连接'
      scheduleReconnect()
      return
    }
    socket.value = ws
    const isCurrent = () => active && generation === connectionGeneration && socket.value === ws
    joinTimer = window.setTimeout(() => {
      if (isCurrent() && !joined) recoverConnection('等待协同连接超时，正在重试')
    }, JOIN_TIMEOUT)
    ws.onopen = () => {
      if (!isCurrent()) return
      joinRevision = revision.value
      if (!sendFrame({ type: 'hello', docId, clientId, hostname: application, lastRev: joinRevision })) {
        recoverConnection('连接握手未发送，正在重试')
        return
      }
      beginHeartbeat()
    }
    ws.onmessage = (event) => {
      if (isCurrent()) handleMessage(event)
    }
    ws.onerror = () => {
      if (!isCurrent()) return
      recoverConnection('实时连接发生异常，正在重新连接')
    }
    ws.onclose = (event) => {
      if (!isCurrent()) return
      if (TERMINAL_CLOSE_CODES.has(event.code)) {
        stopConnection('协同连接已被服务器关闭，请重新连接')
        return
      }
      recoverConnection('连接已断开，正在重新连接')
    }
  }

  function sendOperation(partial) {
    if (!canEdit.value || !credentialsAreCurrent()) return false
    // Store exactly the wire value so a caller mutating its input later cannot
    // change a retry's payload while retaining the original operation identity.
    let operation
    try {
      operation = JSON.parse(JSON.stringify({ ...partial, clock: clock.tick() }))
    } catch {
      error.value = '修改内容无法发送，请检查输入'
      return false
    }
    const entry = { operation, sentAt: Date.now(), attempts: 1 }
    pending.set(operation.clock, entry)
    pendingCount.value = pending.size
    if (applyOperation(state, operation)) bump()
    const sent = sendFrame({ type: 'op', docId, clientId, baseRev: revision.value, op: operation })
    if (!sent) {
      pending.delete(operation.clock)
      pendingCount.value = pending.size
      rebuildOptimisticState()
      recoverConnection('连接已断开，本次修改未发送；此前修改将在恢复后继续同步')
      return false
    }
    syncNotice = ''
    error.value = ''
    return true
  }

  function addElement(elementId, elementType) {
    return setElement(elementId, elementType, {})
  }

  function putField(elementId, elementType, field, value) {
    const current = state.elements.get(elementId) || state.deletedElements.get(elementId)
    const values = Object.fromEntries(
      Object.entries(current?.fields || {})
        .filter(([key]) => key !== '#version')
        .map(([key, field]) => [key, field.value]),
    )
    return setElement(elementId, elementType, { ...values, [field]: value })
  }

  function deleteElement(elementId, elementType) {
    return putField(elementId, elementType, '#tombstone', true)
  }

  function setElement(elementId, elementType, value) {
    return sendOperation({ type: 'STATE', elementId, elementType, value, opId: crypto.randomUUID() })
  }

  function reloadSnapshot() {
    if (!active || !retryAllowed.value) return
    // Explicit history restoration is authoritative. Network reconnection uses
    // recoverConnection instead and never discards these pending operations.
    clearPending()
    rebuildOptimisticState()
    revision.value = 0
    syncNotice = ''
    retry()
  }

  function retry() {
    if (!active || !retryAllowed.value) return false
    manualClose = false
    joinFailures = 0
    reconnectAttempt = 0
    for (const entry of pending.values()) entry.attempts = 0
    detachSocket()
    if (!credentialsAreCurrent()) return false
    scheduleReconnect(true)
    return true
  }

  function close() {
    active = false
    manualClose = true
    detachSocket(1000, 'view closed')
    clearPending()
    status.value = 'closed'
  }

  connect()
  onBeforeUnmount(close)

  return {
    clientId,
    docId,
    state,
    stateVersion: readonly(stateVersion),
    elements,
    status: readonly(status),
    connected,
    role: readonly(role),
    canEdit,
    revision: readonly(revision),
    members: readonly(members),
    metadata: readonly(metadata),
    pendingCount: readonly(pendingCount),
    error: readonly(error),
    retryAllowed: readonly(retryAllowed),
    addElement,
    setElement,
    putField,
    deleteElement,
    reloadSnapshot,
    retry,
    close,
  }
}
