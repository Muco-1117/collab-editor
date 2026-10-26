import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const response = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
function deferred() {
  let resolve
  const promise = new Promise((ok) => {
    resolve = ok
  })
  return { promise, resolve }
}

function accountToken(uid, generation = 1) {
  return `header.${btoa(JSON.stringify({ uid, sub: `account-${uid}`, iat: generation }))}.signature`
}

function storageEvent(key = 'collab_access_token') {
  const event = new Event('storage')
  Object.defineProperty(event, 'key', { value: key })
  window.dispatchEvent(event)
}

describe('account state recovery', () => {
  let store, client, fetchMock
  beforeEach(async () => {
    vi.resetModules()
    const storage = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    })
    vi.stubGlobal('window', new EventTarget())
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    client = await import('../lib/apiClient.js')
    client.setToken('saved-token')
    store = (await import('../stores/auth.js')).authStore
  })
  afterEach(() => vi.unstubAllGlobals())

  it('keeps the stored token when initial profile loading temporarily fails and can retry it', async () => {
    fetchMock.mockResolvedValue(response({ msg: '服务暂时不可用' }, 503))
    await store.init()
    expect(store.state.initError).toBe('服务暂时不可用')
    expect(store.state.token).toBe('saved-token')
    expect(client.getToken()).toBe('saved-token')
    expect(store.isAuthenticated.value).toBe(false)
    fetchMock.mockResolvedValue(response({ user: { id: 1, username: 'alice' } }))
    await store.init(true)
    expect(store.state.initError).toBe('')
    expect(store.isAuthenticated.value).toBe(true)
    expect(store.state.user.username).toBe('alice')
  })

  it('does not restore a logged-out user from an unfinished profile request', async () => {
    const pending = deferred()
    fetchMock.mockReturnValue(pending.promise)
    const loading = store.loadMe()
    store.logout()
    pending.resolve(response({ user: { id: 1 } }))
    await expect(loading).rejects.toMatchObject({ status: 409 })
    expect(store.state.user).toBeNull()
    expect(store.state.token).toBe('')
  })

  it('does not resurrect a cancelled login when its token response arrives later', async () => {
    const pending = deferred()
    fetchMock.mockReturnValue(pending.promise)
    const login = store.login({ username: 'alice', password: 'password' })
    store.logout()
    pending.resolve(response({ token: 'late-token', user: { id: 1 } }))
    await expect(login).rejects.toMatchObject({ status: 409 })
    expect(client.getToken()).toBe('')
    expect(store.state.user).toBeNull()
    expect(store.state.loading).toBe(false)
  })

  it('deduplicates login attempts at the store boundary', async () => {
    const pending = deferred()
    fetchMock.mockReturnValue(pending.promise)
    const first = store.login({ username: 'alice', password: 'password' })
    await store.login({ username: 'alice', password: 'password' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    pending.resolve(response({ token: 'new-token', user: { id: 1 } }))
    await first
    expect(store.isAuthenticated.value).toBe(true)
    expect(store.state.loading).toBe(false)
  })

  it('retains a newly issued token if loading the profile after login fails', async () => {
    fetchMock.mockImplementation((path) =>
      Promise.resolve(
        path === '/api/auth/login'
          ? response({ token: 'new-token' })
          : response({ msg: '资料暂时不可用' }, 503),
      ),
    )
    await expect(store.login({ username: 'alice', password: 'password' })).rejects.toMatchObject({
      status: 503,
    })
    expect(client.getToken()).toBe('new-token')
    expect(store.state.initError).toBe('资料暂时不可用')
    fetchMock.mockResolvedValue(response({ user: { id: 1 } }))
    await store.init(true)
    expect(store.isAuthenticated.value).toBe(true)
    expect(store.state.initError).toBe('')
  })

  it('clears the user and token only when authentication is actually rejected', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(response({ msg: '已过期' }, 401)))
    await store.init()
    expect(client.getToken()).toBe('')
    expect(store.state.token).toBe('')
    expect(store.state.user).toBeNull()
    expect(store.state.initError).toBe('')
  })

  it('clears the old account before accepting an external session and does not write the token back', async () => {
    fetchMock.mockResolvedValue(response({ user: { id: 1, nickname: '旧账号' } }))
    await store.init()
    const write = vi.spyOn(localStorage, 'setItem')
    localStorage.setItem(client.TOKEN_KEY, 'other-account')
    write.mockClear()
    storageEvent()
    expect(store.state.user).toBeNull()
    expect(store.state.token).toBe('other-account')
    expect(store.state.sessionChanging).toBe(true)
    expect(store.state.sessionEpoch).toBe(1)
    await expect(client.api('/api/docs/old', { method: 'DELETE' })).rejects.toMatchObject({ status: 409 })
    fetchMock.mockResolvedValue(response({ user: { id: 2, nickname: '新账号' } }))
    await expect(store.resumeStoredSession(1)).resolves.toBe(true)
    expect(store.state.user.id).toBe(2)
    expect(store.state.sessionChanging).toBe(true)
    store.finishStoredSession(1)
    expect(store.state.sessionChanging).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it('synchronizes logout and ignores unrelated or obsolete storage events', async () => {
    fetchMock.mockResolvedValue(response({ user: { id: 1 } }))
    await store.init()
    storageEvent('other-preference')
    expect(store.state.sessionEpoch).toBe(0)
    localStorage.removeItem(client.TOKEN_KEY)
    storageEvent(null)
    storageEvent()
    expect(store.state.sessionEpoch).toBe(1)
    expect(store.state.user).toBeNull()
    await store.resumeStoredSession(1)
    store.finishStoredSession(1)
    expect(store.isAuthenticated.value).toBe(false)
    expect(store.state.initialized).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the current account and epoch for same-account token rotation', async () => {
    client.setToken(accountToken(1, 1))
    fetchMock.mockResolvedValue(response({ user: { id: 1, nickname: '同一账号' } }))
    await store.init()
    const user = store.state.user
    const version = client.getSessionVersion()
    const rotated = accountToken(1, 2)
    localStorage.setItem(client.TOKEN_KEY, rotated)
    storageEvent()
    expect(store.state.token).toBe(rotated)
    expect(store.state.user).toBe(user)
    expect(store.state.sessionChanging).toBe(false)
    expect(store.state.sessionEpoch).toBe(0)
    expect(client.getSessionVersion()).toBe(version)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not let a superseded init promise or response replace the most recent account', async () => {
    const first = deferred()
    const second = deferred()
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const oldInit = store.init()
    localStorage.setItem(client.TOKEN_KEY, 'second-account')
    storageEvent()
    const secondInit = store.resumeStoredSession(1)
    first.resolve(response({ user: { id: 1 } }))
    await oldInit
    expect(store.state.user).toBeNull()
    expect(store.state.initialized).toBe(false)
    const sameInit = store.init(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    second.resolve(response({ user: { id: 2 } }))
    await secondInit
    await sameInit
    expect(store.state.user.id).toBe(2)
  })

  it('recovers a newly selected account after a temporary profile failure', async () => {
    localStorage.setItem(client.TOKEN_KEY, 'second-account')
    storageEvent()
    fetchMock.mockResolvedValue(response({ msg: '暂时无法读取资料' }, 503))
    await expect(store.resumeStoredSession(1)).resolves.toBe(true)
    store.finishStoredSession(1)
    expect(store.state.initError).toBe('暂时无法读取资料')
    expect(client.getToken()).toBe('second-account')
    expect(store.state.user).toBeNull()
    fetchMock.mockResolvedValue(response({ user: { id: 2 } }))
    await store.init(true)
    expect(store.state.user.id).toBe(2)
    expect(store.state.initError).toBe('')
  })

  it('finishes switching to an expired external session at the login boundary', async () => {
    localStorage.setItem(client.TOKEN_KEY, 'expired-account')
    storageEvent()
    fetchMock.mockResolvedValue(response({ msg: '已过期' }, 401))
    await expect(store.resumeStoredSession(1)).resolves.toBe(true)
    store.finishStoredSession(1)
    expect(store.state.sessionChanging).toBe(false)
    expect(store.state.user).toBeNull()
    expect(client.getToken()).toBe('')
  })

  it('cancels a pending login if another tab selected an account', async () => {
    const pending = deferred()
    fetchMock.mockReturnValue(pending.promise)
    const login = store.login({ username: 'alice', password: 'password' })
    localStorage.setItem(client.TOKEN_KEY, 'second-account')
    storageEvent()
    pending.resolve(response({ token: 'late-token', user: { id: 1 } }))
    await expect(login).rejects.toMatchObject({ status: 409 })
    expect(client.getToken()).toBe('second-account')
    expect(store.state.loading).toBe(false)
    expect(store.state.user).toBeNull()
  })

  it('ignores an old transition completion after a newer account change', async () => {
    const pending = deferred()
    fetchMock.mockReturnValueOnce(pending.promise).mockResolvedValue(response({ user: { id: 3 } }))
    localStorage.setItem(client.TOKEN_KEY, 'second-account')
    storageEvent()
    const second = store.resumeStoredSession(1)
    localStorage.setItem(client.TOKEN_KEY, 'third-account')
    storageEvent()
    await store.resumeStoredSession(2)
    store.finishStoredSession(1)
    expect(store.state.sessionChanging).toBe(true)
    pending.resolve(response({ user: { id: 2 } }))
    await expect(second).resolves.toBe(false)
    expect(store.state.user.id).toBe(3)
    store.finishStoredSession(2)
    expect(store.state.sessionChanging).toBe(false)
  })

  it('rechecks storage on focus when a browser delayed its storage events', async () => {
    localStorage.setItem(client.TOKEN_KEY, 'second-account')
    window.dispatchEvent(new Event('focus'))
    expect(store.state.sessionChanging).toBe(true)
    expect(store.state.token).toBe('second-account')
  })

  it('does not issue a login against an old screen before a delayed storage event arrives', async () => {
    localStorage.setItem(client.TOKEN_KEY, 'second-account')
    await expect(store.login({ username: 'alice', password: 'password' })).rejects.toMatchObject({
      data: { code: 'SESSION_CHANGED' },
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(store.state.loading).toBe(false)
    expect(store.state.sessionChanging).toBe(true)
  })

  it('detects an account switch during route initialization before its storage event arrives', async () => {
    fetchMock.mockResolvedValue(response({ user: { id: 1 } }))
    await store.init()
    localStorage.setItem(client.TOKEN_KEY, 'second-account')
    await store.init()
    expect(store.state.sessionChanging).toBe(true)
    expect(store.state.initialized).toBe(false)
    expect(store.state.user).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fetchMock.mockResolvedValue(response({ user: { id: 2 } }))
    await store.resumeStoredSession(1)
    expect(store.state.user.id).toBe(2)
  })
})
