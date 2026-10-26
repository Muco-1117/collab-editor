// 栏目由 URL 决定；旧 kind/layout 仅兼容已有存储，首页不再使用分类筛选。
const defaults = { kind: 'all', layout: 'list', sort: 'updated' }
const choices = {
  kind: ['all', 'doc', 'board', 'kanban'],
  layout: ['list', 'grid'],
  sort: ['updated', 'title'],
}

function normalize(value) {
  return Object.fromEntries(
    Object.entries(defaults).map(([key, fallback]) => [
      key,
      choices[key].includes(value?.[key]) ? value[key] : fallback,
    ]),
  )
}

export function readDashboardPreferences(userId, storage = window.localStorage) {
  try {
    return normalize(JSON.parse(storage.getItem(`collab_dashboard:${userId}`)))
  } catch {
    return { ...defaults }
  }
}

export function saveDashboardPreferences(userId, value, storage = window.localStorage) {
  try {
    storage.setItem(`collab_dashboard:${userId}`, JSON.stringify(normalize(value)))
  } catch {
    /* 存储不可用时仍允许本次使用。 */
  }
}
