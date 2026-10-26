const limit = 24
const kinds = new Set(['doc', 'board', 'kanban'])

function storageKey(userId) {
  return `collab_recent_work:${userId}`
}

function normalize(rows) {
  if (!Array.isArray(rows)) return []
  const seen = new Set()
  return rows
    .filter((row) => {
      if (
        typeof row?.docKey !== 'string' ||
        !row.docKey ||
        !/^[1-9]\d*$/.test(String(row.spaceId)) ||
        !kinds.has(row.kind) ||
        !Number.isFinite(row.openedAt) ||
        row.openedAt <= 0 ||
        seen.has(row.docKey)
      )
        return false
      seen.add(row.docKey)
      return true
    })
    .map(({ docKey, spaceId, kind, openedAt }) => ({ docKey, spaceId: String(spaceId), kind, openedAt }))
    .sort((left, right) => right.openedAt - left.openedAt)
    .slice(0, limit)
}

export function readRecentWork(userId, storage = window.localStorage) {
  if (userId == null) return []
  try {
    return normalize(JSON.parse(storage.getItem(storageKey(userId))))
  } catch {
    return []
  }
}

export function recordRecentWork(userId, document, storage = window.localStorage, now = Date.now()) {
  if (userId == null) return
  const docKey = document?.doc_key || document?.docKey
  const next = normalize([
    {
      docKey,
      spaceId: document?.space_id ?? document?.spaceId,
      kind: document?.kind || 'doc',
      openedAt: now,
    },
    ...readRecentWork(userId, storage).filter((row) => row.docKey !== docKey),
  ])
  try {
    storage.setItem(storageKey(userId), JSON.stringify(next))
  } catch {
    // 无痕模式或存储已满时，内容仍能正常打开。
  }
}

export function recentVisibleWork(records, documents, spaceId, count = 4) {
  const visible = new Map(
    documents.map((document) => [String(document.doc_key || document.docKey), document]),
  )
  return normalize(records)
    .filter((row) => row.spaceId === String(spaceId) && visible.has(row.docKey))
    .slice(0, count)
    .map((row) => ({ ...visible.get(row.docKey), openedAt: row.openedAt }))
}
