import { describe, expect, it } from 'vitest'
import { readRecentWork, recentVisibleWork, recordRecentWork } from '../lib/recentWork.js'

function memoryStorage() {
  const values = new Map()
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
}

describe('recent work', () => {
  it('isolates accounts, deduplicates reopened content and stores no title or body', () => {
    const storage = memoryStorage()
    recordRecentWork(7, { docKey: 'a', spaceId: 2, title: '私有标题' }, storage, 100)
    recordRecentWork(7, { docKey: 'b', spaceId: 2, kind: 'board' }, storage, 200)
    recordRecentWork(7, { docKey: 'a', spaceId: 2, title: '新名称' }, storage, 300)
    expect(readRecentWork(7, storage)).toEqual([
      { docKey: 'a', spaceId: '2', kind: 'doc', openedAt: 300 },
      { docKey: 'b', spaceId: '2', kind: 'board', openedAt: 200 },
    ])
    expect(readRecentWork(8, storage)).toEqual([])
    expect(storage.getItem('collab_recent_work:7')).not.toContain('标题')
  })

  it('shows only currently accessible content in the selected space using its current name', () => {
    const records = [
      { docKey: 'deleted', spaceId: '2', kind: 'doc', openedAt: 400 },
      { docKey: 'other-space', spaceId: '3', kind: 'board', openedAt: 300 },
      { docKey: 'renamed', spaceId: '2', kind: 'kanban', openedAt: 200 },
    ]
    const docs = [{ doc_key: 'renamed', title: '当前名称', space_id: 2, kind: 'kanban' }]
    expect(recentVisibleWork(records, docs, 2)).toEqual([{ ...docs[0], openedAt: 200 }])
    expect(recentVisibleWork(records, docs, 3)).toEqual([])
  })

  it('bounds stored history and tolerates denied or malformed storage', () => {
    const storage = memoryStorage()
    for (let i = 1; i <= 30; i++) recordRecentWork(7, { docKey: `d${i}`, spaceId: 2 }, storage, i)
    expect(readRecentWork(7, storage)).toHaveLength(24)
    expect(readRecentWork(7, storage)[0].docKey).toBe('d30')
    storage.setItem('collab_recent_work:7', '[null,{},"bad"]')
    expect(readRecentWork(7, storage)).toEqual([])
    const blocked = {
      getItem: () => {
        throw Error('blocked')
      },
      setItem: () => {
        throw Error('blocked')
      },
    }
    expect(() => recordRecentWork(7, { docKey: 'a', spaceId: 2 }, blocked, 1)).not.toThrow()
    expect(readRecentWork(7, blocked)).toEqual([])
  })
})
