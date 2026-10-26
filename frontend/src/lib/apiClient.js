export const TOKEN_KEY = 'collab_access_token'
let observedToken
let sessionVersion = 0
let refreshJob = null
let pendingSessionVersion = null

export class ApiError extends Error {
  constructor(message, status, data = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.data = data
  }
}

function tokenSubject(token) {
  try {
    const payload = token.split('.')[1]?.replace(/-/g, '+').replace(/_/g, '/')
    const claims = payload && JSON.parse(atob(payload))
    // This only distinguishes UI sessions. The server still validates the JWT.
    return claims?.uid != null && claims?.sub ? `${claims.uid}:${claims.sub}` : null
  } catch {
    return null
  }
}

function dispatchSessionEvent(type) {
  window.dispatchEvent?.(new CustomEvent(type))
}

export function getToken() {
  const token = localStorage.getItem(TOKEN_KEY) || ''
  const previous = observedToken
  observedToken = token
  if (previous !== undefined && previous !== token) {
    const subject = tokenSubject(previous)
    if (subject && subject === tokenSubject(token)) {
      dispatchSessionEvent('collab:token-refreshed')
    } else {
      sessionVersion += 1
      pendingSessionVersion = sessionVersion
      // Synchronous notification prevents an old view from issuing a request
      // with another account's credentials before the storage event is handled.
      dispatchSessionEvent('collab:session-changed')
    }
  }
  return token
}

function writeToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
  observedToken = token || ''
}

export function setToken(token) {
  // Login/logout start a new session even if the server issued the same token.
  // A token refresh below deliberately keeps the current session generation.
  sessionVersion += 1
  pendingSessionVersion = null
  writeToken(token)
}

export function acceptStoredSession(version) {
  if (version !== getSessionVersion()) return false
  if (pendingSessionVersion === version) pendingSessionVersion = null
  return true
}

export function getSessionVersion() {
  getToken()
  return sessionVersion
}

function assertSession(session) {
  if (session && session.version !== getSessionVersion()) {
    throw new ApiError('登录状态已变更，请重新操作', 409, { code: 'SESSION_CHANGED' })
  }
}

function checkAborted(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException('请求已取消', 'AbortError')
}

function waitWithSignal(promise, signal) {
  if (!signal) return promise
  checkAborted(signal)
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', aborted)
    const aborted = () => {
      cleanup()
      reject(signal.reason || new DOMException('请求已取消', 'AbortError'))
    }
    signal.addEventListener('abort', aborted, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
  })
}

async function fetchResponse(path, options) {
  checkAborted(options.signal)
  try {
    return await fetch(path, options)
  } catch (error) {
    checkAborted(options.signal)
    if (error?.name === 'AbortError') throw error
    throw new ApiError('无法连接服务器，请检查网络和服务状态后重试', 0)
  }
}

async function readData(response, signal) {
  if (response.status === 204) return null
  try {
    return (response.headers.get('content-type') || '').includes('application/json')
      ? await response.json()
      : await response.text()
  } catch (error) {
    checkAborted(signal)
    if (error?.name === 'AbortError') throw error
    if (!response.ok) return null
    throw new ApiError('服务器返回的数据无法读取，请重试', 502)
  }
}

async function refreshToken(session, token) {
  assertSession(session)
  if (!refreshJob || refreshJob.version !== session.version || refreshJob.token !== token) {
    const job = { version: session.version, token }
    job.promise = (async () => {
      const response = await fetchResponse('/api/auth/refresh', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      assertSession(session)
      const data = await readData(response)
      assertSession(session)
      // Another tab may have refreshed the same account while this request
      // was pending. Its current token wins over this older refresh result.
      const currentToken = getToken()
      if (currentToken !== token) return currentToken
      if (!response.ok) {
        throw new ApiError(
          response.status === 401 || response.status === 403
            ? '登录已过期，请重新登录'
            : '暂时无法验证登录状态，请稍后重试',
          response.status,
          data,
        )
      }
      if (typeof data?.token !== 'string' || !data.token) {
        throw new ApiError('暂时无法刷新登录状态，请稍后重试', 502)
      }
      writeToken(data.token)
      window.dispatchEvent(new CustomEvent('collab:token-refreshed'))
      return data.token
    })().finally(() => {
      if (refreshJob === job) refreshJob = null
    })
    refreshJob = job
  }
  return refreshJob.promise
}

function expireSession(session) {
  assertSession(session)
  setToken('')
  window.dispatchEvent(new CustomEvent('collab:unauthorized'))
}

async function requestResponse(path, options = {}) {
  const { auth = true, body, headers = {}, _retried, ...rest } = options
  const session = auth ? { version: getSessionVersion() } : null
  if (auth && pendingSessionVersion != null) {
    throw new ApiError('登录账号已变更，正在切换工作台', 409, { code: 'SESSION_CHANGED' })
  }
  const payload =
    body == null || body instanceof FormData || typeof body === 'string' ? body : JSON.stringify(body)

  for (let attempt = 0; attempt < 2; attempt++) {
    checkAborted(rest.signal)
    const token = getToken()
    // Capturing credentials can detect another tab's account switch. Validate
    // afterward, then send only this captured token on the first try or retry.
    assertSession(session)
    const requestHeaders = new Headers(headers)
    if (auth && token) requestHeaders.set('Authorization', `Bearer ${token}`)
    if (body != null && !(body instanceof FormData) && !requestHeaders.has('Content-Type')) {
      requestHeaders.set('Content-Type', 'application/json')
    }
    const response = await fetchResponse(path, { ...rest, headers: requestHeaders, body: payload })
    assertSession(session)
    checkAborted(rest.signal)
    if (response.status === 401 && auth) {
      if (attempt === 0 && token) {
        // Another request may have refreshed this same session while this one
        // was in flight. Reuse that token instead of issuing a second refresh.
        if (token === getToken()) {
          try {
            await waitWithSignal(refreshToken(session, token), rest.signal)
          } catch (error) {
            assertSession(session)
            checkAborted(rest.signal)
            if (error.status === 401 || error.status === 403) expireSession(session)
            throw error
          }
        }
        continue
      }
      if (token !== getToken()) {
        throw new ApiError('登录凭据已更新，请重试', 409, { code: 'TOKEN_UPDATED' })
      }
      expireSession(session)
      throw new ApiError('登录已过期，请重新登录', 401)
    }
    if (!response.ok) {
      const data = await readData(response, rest.signal)
      assertSession(session)
      const message = data?.msg || data?.message
      throw new ApiError(
        typeof message === 'string' ? message : `请求失败（${response.status}）`,
        response.status,
        data,
      )
    }
    return { response, session }
  }
}

export async function api(path, options = {}) {
  const { response, session } = await requestResponse(path, options)
  const data = await readData(response, options.signal)
  assertSession(session)
  return data
}

async function readBlob(response, signal) {
  try {
    return await response.blob()
  } catch (error) {
    checkAborted(signal)
    if (error?.name === 'AbortError') throw error
    throw new ApiError('文件读取失败，请重试', 0)
  }
}

export async function apiBlob(path, options = {}) {
  const { response, session } = await requestResponse(path, options)
  const blob = await readBlob(response, options.signal)
  assertSession(session)
  return blob
}

export async function download(path, fallbackName = '下载文件') {
  const { response, session } = await requestResponse(path)
  const blob = await readBlob(response)
  assertSession(session)
  const disposition = response.headers.get('content-disposition') || ''
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  const plain = disposition.match(/filename="?([^";]+)"?/i)?.[1]
  let filename = plain || fallbackName
  if (encoded) {
    try {
      filename = decodeURIComponent(encoded)
    } catch {
      /* Keep the usable fallback. */
    }
  }
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  try {
    anchor.click()
  } finally {
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}
