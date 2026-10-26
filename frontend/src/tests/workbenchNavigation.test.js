import { describe, expect, it } from 'vitest'
import { readDashboardPreferences } from '../lib/dashboardPreferences.js'
import { readWorkbenchReturn, rememberWorkbenchLocation, workbenchRoute } from '../lib/workbenchNavigation.js'

function memoryStorage() {
  const values = new Map()
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
}

describe('workbench return navigation', () => {
  it('keeps the originating library and space isolated by account', () => {
    const storage = memoryStorage()
    rememberWorkbenchLocation(12, { section: 'library', kind: 'board', spaceId: 42 }, storage)
    rememberWorkbenchLocation(13, { section: 'members', spaceId: 71 }, storage)
    expect(readWorkbenchReturn(12, storage)).toEqual({
      name: 'content-library',
      params: { kind: 'board' },
      query: { space: '42' },
    })
    expect(readWorkbenchReturn(13, storage)).toEqual({ name: 'space-members', query: { space: '71' } })
    expect(readWorkbenchReturn(14, storage)).toEqual({ name: 'dashboard', query: {} })
  })

  it('falls back from malformed storage and does not accept arbitrary return paths', () => {
    const storage = memoryStorage()
    storage.setItem('collab_workbench:12', '{')
    expect(readWorkbenchReturn(12, storage)).toEqual({ name: 'dashboard', query: {} })
    expect(workbenchRoute({ section: 'library', kind: 'invalid', spaceId: '../42', path: '/login' })).toEqual(
      { name: 'dashboard', query: {} },
    )
    const blocked = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(() => rememberWorkbenchLocation(12, { section: 'content' }, blocked)).not.toThrow()
    expect(readWorkbenchReturn(12, blocked)).toEqual({ name: 'dashboard', query: {} })
  })

  it('ignores the legacy stored section while preserving home filters and display preferences', () => {
    const storage = memoryStorage()
    storage.setItem(
      'collab_dashboard:12',
      JSON.stringify({
        section: 'stats',
        kind: 'kanban',
        layout: 'grid',
        sort: 'title',
      }),
    )
    expect(readDashboardPreferences(12, storage)).toEqual({ kind: 'kanban', layout: 'grid', sort: 'title' })
  })
})
