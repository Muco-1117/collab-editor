import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function deferred() {
  let resolve, reject
  const promise = new Promise((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function accountToken(uid, generation = 1) {
  const body = btoa(JSON.stringify({ uid, sub: `account-${uid}`, iat: generation }))
  return `eyJhbGciOiJIUzI1NiJ9.${body}.test-signature`
}

function changeTokenOnStorageRead(client, token, readToChange) {
  const read = localStorage.getItem.bind(localStorage)
  let reads = 0
  vi.spyOn(localStorage, 'getItem').mockImplementation((key) => {
    if (key === client.TOKEN_KEY && ++reads === readToChange) localStorage.setItem(key, token)
    return read(key)
  })
}

describe('authenticated requests', () => {
  let client, fetchMock, events, anchor

  beforeEach(async () => {
    vi.resetModules()
    const data = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (key) => data.get(key) || null,
      setItem: (key, value) => data.set(key, value),
      removeItem: (key) => data.delete(key),
    })
    events = []
    vi.stubGlobal('window', {
      dispatchEvent: (event) => events.push(event.type),
      setTimeout: (callback) => callback(),
    })
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    anchor = { click: vi.fn(), remove: vi.fn() }
    vi.stubGlobal('document', { createElement: () => anchor, body: { appendChild: vi.fn() } })
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:download-test')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    client = await import('../lib/apiClient.js')
    client.setToken('session-a')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('cancels one caller while a shared refresh is still pending without cancelling the other', async () => {
    const refresh = deferred()
    fetchMock.mockImplementation((path, options) => {
      if (path === '/api/auth/refresh') return refresh.promise
      return Promise.resolve(
        new Headers(options.headers).get('Authorization') === 'Bearer refreshed-a'
          ? json({ ok: true })
          : json({}, 401),
      )
    })
    const controller = new AbortController()
    const first = client.api('/api/docs', { signal: controller.signal })
    const second = client.api('/api/spaces')
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.filter(([path]) => path === '/api/auth/refresh')).toHaveLength(1),
    )
    controller.abort()
    await rejected
    expect(client.getToken()).toBe('session-a')
    refresh.resolve(json({ token: 'refreshed-a' }))
    await expect(second).resolves.toEqual({ ok: true })
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/auth/refresh')).toHaveLength(1)
  })

  it('shares one refresh across simultaneous unauthorized requests', async () => {
    const refresh = deferred()
    fetchMock.mockImplementation((path, options) => {
      if (path === '/api/auth/refresh') return refresh.promise
      return Promise.resolve(
        new Headers(options.headers).get('Authorization') === 'Bearer refreshed-a'
          ? json({ path })
          : json({ msg: 'expired' }, 401),
      )
    })
    const first = client.api('/api/docs'),
      second = client.api('/api/spaces')
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.filter(([path]) => path === '/api/auth/refresh')).toHaveLength(1),
    )
    refresh.resolve(json({ token: 'refreshed-a' }))
    await expect(first).resolves.toEqual({ path: '/api/docs' })
    await expect(second).resolves.toEqual({ path: '/api/spaces' })
    expect(client.getToken()).toBe('refreshed-a')
    expect(events).toEqual(['collab:token-refreshed'])
  })

  it('does not refresh or clear a new login because an old request returned 401', async () => {
    const old = deferred()
    fetchMock.mockReturnValue(old.promise)
    const request = client.api('/api/docs')
    client.setToken('session-b')
    old.resolve(json({ msg: 'expired' }, 401))
    await expect(request).rejects.toMatchObject({ data: { code: 'SESSION_CHANGED' } })
    expect(client.getToken()).toBe('session-b')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(events).toEqual([])
  })

  it('discards a refresh result after logout or another login', async () => {
    const refresh = deferred()
    fetchMock.mockImplementation((path) =>
      path === '/api/auth/refresh' ? refresh.promise : Promise.resolve(json({}, 401)),
    )
    const request = client.api('/api/docs')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    client.setToken('session-b')
    refresh.resolve(json({ token: 'refreshed-a' }))
    await expect(request).rejects.toMatchObject({ data: { code: 'SESSION_CHANGED' } })
    expect(client.getToken()).toBe('session-b')
    expect(events).toEqual([])
  })

  it.each([503, 0])('preserves the session when refreshing fails temporarily with %s', async (status) => {
    fetchMock.mockImplementation((path) => {
      if (path !== '/api/auth/refresh') return Promise.resolve(json({}, 401))
      return status ? Promise.resolve(json({}, status)) : Promise.reject(new TypeError('Failed to fetch'))
    })
    await expect(client.api('/api/docs')).rejects.toMatchObject({ status })
    expect(client.getToken()).toBe('session-a')
    expect(events).toEqual([])
  })

  it('expires the current session when refresh is explicitly rejected', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json({}, 401)))
    await expect(client.api('/api/docs')).rejects.toMatchObject({ status: 401 })
    expect(client.getToken()).toBe('')
    expect(events).toEqual(['collab:unauthorized'])
  })

  it('does not log out an existing session when an unauthenticated login attempt fails', async () => {
    fetchMock.mockResolvedValue(json({ msg: '用户名或密码错误' }, 401))
    await expect(
      client.api('/api/auth/login', { auth: false, method: 'POST', body: { password: 'wrong' } }),
    ).rejects.toMatchObject({ message: '用户名或密码错误', status: 401 })
    expect(client.getToken()).toBe('session-a')
    expect(events).toEqual([])
  })

  it('preserves abort semantics without turning cancellation into a server failure', async () => {
    const abort = new DOMException('cancelled', 'AbortError')
    fetchMock.mockRejectedValue(abort)
    await expect(client.api('/api/docs')).rejects.toBe(abort)
    expect(events).toEqual([])
  })

  it('does not apply successful data from a previous session', async () => {
    const body = deferred()
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => body.promise,
    })
    const request = client.api('/api/auth/me')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    client.setToken('session-b')
    body.resolve({ user: { id: 1 } })
    await expect(request).rejects.toMatchObject({ data: { code: 'SESSION_CHANGED' } })
    expect(client.getToken()).toBe('session-b')
  })

  it('reuses a token already refreshed by another request for a late 401', async () => {
    const late = deferred()
    let lateAttempts = 0
    fetchMock.mockImplementation((path, options) => {
      if (path === '/api/auth/refresh') return Promise.resolve(json({ token: 'refreshed-a' }))
      if (path === '/api/late' && lateAttempts++ === 0) return late.promise
      return Promise.resolve(
        new Headers(options.headers).get('Authorization') === 'Bearer refreshed-a'
          ? json({ ok: true })
          : json({}, 401),
      )
    })
    const delayed = client.api('/api/late')
    await client.api('/api/first')
    late.resolve(json({}, 401))
    await expect(delayed).resolves.toEqual({ ok: true })
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/auth/refresh')).toHaveLength(1)
  })

  it('downloads with the same refresh flow and decodes a Chinese filename', async () => {
    let attempts = 0
    fetchMock.mockImplementation((path) => {
      if (path === '/api/auth/refresh') return Promise.resolve(json({ token: 'refreshed-a' }))
      return Promise.resolve(
        attempts++ === 0
          ? json({}, 401)
          : new Response('export', {
              headers: {
                'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent('项目说明.md')}`,
              },
            }),
      )
    })
    await client.download('/api/docs/a/export', 'fallback.md')
    expect(anchor.download).toBe('项目说明.md')
    expect(anchor.click).toHaveBeenCalledTimes(1)
    expect(anchor.remove).toHaveBeenCalledTimes(1)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:download-test')
  })

  it('uses the fallback if a response has a malformed encoded filename', async () => {
    fetchMock.mockResolvedValue(
      new Response('export', {
        headers: { 'content-disposition': "attachment; filename*=UTF-8''%bad%encoding" },
      }),
    )
    await client.download('/api/docs/a/export', '项目.md')
    expect(anchor.download).toBe('项目.md')
    expect(anchor.click).toHaveBeenCalledTimes(1)
  })

  it('does not download a file when the account changed while the response body was arriving', async () => {
    const body = deferred()
    fetchMock.mockResolvedValue({ ok: true, status: 200, headers: new Headers(), blob: () => body.promise })
    const request = client.download('/api/docs/a/export', 'project.md')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    client.setToken('session-b')
    body.resolve(new Blob(['old account content']))
    await expect(request).rejects.toMatchObject({ data: { code: 'SESSION_CHANGED' } })
    expect(anchor.click).not.toHaveBeenCalled()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('blocks an old view from sending a mutation with credentials changed in another tab', async () => {
    localStorage.setItem(client.TOKEN_KEY, 'session-b')
    await expect(client.api('/api/docs/old-document', { method: 'DELETE' })).rejects.toMatchObject({
      data: { code: 'SESSION_CHANGED' },
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(events).toEqual(['collab:session-changed'])
    const version = client.getSessionVersion()
    expect(client.acceptStoredSession(version - 1)).toBe(false)
    expect(client.acceptStoredSession(version)).toBe(true)
    fetchMock.mockResolvedValue(json({ user: { id: 2 } }))
    await client.api('/api/auth/me')
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('Authorization')).toBe('Bearer session-b')
  })

  it.each([2, 3])(
    'does not send a mutation when another tab switches accounts on pre-send storage read %i',
    async (readToChange) => {
      client.setToken(accountToken(1))
      changeTokenOnStorageRead(client, accountToken(2), readToChange)
      fetchMock.mockResolvedValue(json({ deleted: true }))

      await expect(client.api('/api/docs/shared-document', { method: 'DELETE' })).rejects.toMatchObject({
        status: 409,
        data: { code: 'SESSION_CHANGED' },
      })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(events).toEqual(['collab:session-changed'])
    },
  )

  it.each([1, 2])(
    'does not retry a mutation when another tab switches accounts on storage read %i after refresh',
    async (readToChange) => {
      const original = accountToken(1, 1)
      client.setToken(original)
      fetchMock.mockImplementation((path) =>
        Promise.resolve(path === '/api/auth/refresh' ? json({ token: accountToken(1, 2) }) : json({}, 401)),
      )
      vi.spyOn(window, 'dispatchEvent').mockImplementation((event) => {
        events.push(event.type)
        if (event.type === 'collab:token-refreshed') {
          changeTokenOnStorageRead(client, accountToken(2), readToChange)
        }
      })

      await expect(
        client.api('/api/docs/shared-document', { method: 'PUT', body: { title: '旧账号的修改' } }),
      ).rejects.toMatchObject({ status: 409, data: { code: 'SESSION_CHANGED' } })
      expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
        '/api/docs/shared-document',
        '/api/auth/refresh',
      ])
      for (const [, options] of fetchMock.mock.calls) {
        expect(new Headers(options.headers).get('Authorization')).toBe(`Bearer ${original}`)
      }
      expect(events).toEqual(['collab:token-refreshed', 'collab:session-changed'])
    },
  )

  it('preserves in-flight responses when another tab rotates the same account token', async () => {
    const pending = deferred()
    client.setToken(accountToken(1, 1))
    const version = client.getSessionVersion()
    fetchMock.mockReturnValue(pending.promise)
    const loading = client.api('/api/docs')
    const rotated = accountToken(1, 2)
    localStorage.setItem(client.TOKEN_KEY, rotated)
    pending.resolve(json({ document: 'same-account' }))
    await expect(loading).resolves.toEqual({ document: 'same-account' })
    expect(client.getSessionVersion()).toBe(version)
    expect(events).toEqual(['collab:token-refreshed'])
  })

  it('reuses a same-account token rotated by another tab for a delayed 401', async () => {
    client.setToken(accountToken(1, 1))
    const pending = deferred()
    fetchMock.mockReturnValueOnce(pending.promise).mockResolvedValue(json({ ok: true }))
    const loading = client.api('/api/docs')
    const rotated = accountToken(1, 2)
    localStorage.setItem(client.TOKEN_KEY, rotated)
    pending.resolve(json({}, 401))
    await expect(loading).resolves.toEqual({ ok: true })
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/api/docs', '/api/docs'])
    expect(new Headers(fetchMock.mock.calls[1][1].headers).get('Authorization')).toBe(`Bearer ${rotated}`)
    expect(events).toEqual(['collab:token-refreshed'])
  })

  it.each([200, 401])(
    'does not overwrite another tab refresh with a delayed %s refresh response',
    async (status) => {
      const firstToken = accountToken(1, 1)
      const rotated = accountToken(1, 3)
      const pending = deferred()
      client.setToken(firstToken)
      fetchMock.mockImplementation((path, options) => {
        if (path === '/api/auth/refresh') return pending.promise
        const current = new Headers(options.headers).get('Authorization') === `Bearer ${rotated}`
        return Promise.resolve(json({ ok: current }, current ? 200 : 401))
      })
      const loading = client.api('/api/docs')
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
      localStorage.setItem(client.TOKEN_KEY, rotated)
      pending.resolve(json({ token: accountToken(1, 2) }, status))
      await expect(loading).resolves.toEqual({ ok: true })
      expect(client.getToken()).toBe(rotated)
      expect(events).toEqual(['collab:token-refreshed'])
    },
  )

  it('discards old account results even when a new account token has already been accepted', async () => {
    client.setToken(accountToken(1))
    const pending = deferred()
    fetchMock.mockReturnValue(pending.promise)
    const loading = client.api('/api/docs')
    localStorage.setItem(client.TOKEN_KEY, accountToken(2))
    client.acceptStoredSession(client.getSessionVersion())
    pending.resolve(json({ secret: 'previous-account' }))
    await expect(loading).rejects.toMatchObject({ data: { code: 'SESSION_CHANGED' } })
    expect(events).toEqual(['collab:session-changed'])
  })
})
