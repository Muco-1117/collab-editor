const sections = new Set(['content', 'library', 'members', 'stats', 'trash'])
const kinds = new Set(['doc', 'board', 'kanban'])

export function normalizeWorkbenchLocation(value) {
  const section = sections.has(value?.section) ? value.section : 'content'
  const kind = section === 'library' && kinds.has(value?.kind) ? value.kind : null
  const space = String(value?.spaceId ?? '')
  return {
    section: section === 'library' && !kind ? 'content' : section,
    kind,
    spaceId: /^[1-9]\d*$/.test(space) ? space : null,
  }
}

export function workbenchRoute(value) {
  const { section, kind, spaceId } = normalizeWorkbenchLocation(value)
  const name = {
    content: 'dashboard',
    library: 'content-library',
    members: 'space-members',
    stats: 'collaboration-stats',
    trash: 'space-trash',
  }[section]
  return { name, ...(kind ? { params: { kind } } : {}), query: spaceId ? { space: spaceId } : {} }
}

export function rememberWorkbenchLocation(userId, value, storage = window.sessionStorage) {
  try {
    storage.setItem(`collab_workbench:${userId}`, JSON.stringify(normalizeWorkbenchLocation(value)))
  } catch {
    /* 路由仍能导航，存储不可用时只不记住返回位置。 */
  }
}

export function readWorkbenchReturn(userId, storage = window.sessionStorage) {
  try {
    return workbenchRoute(JSON.parse(storage.getItem(`collab_workbench:${userId}`)))
  } catch {
    return workbenchRoute(null)
  }
}
