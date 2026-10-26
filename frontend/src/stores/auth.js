import { computed, reactive } from 'vue'
import {
  ApiError,
  TOKEN_KEY,
  acceptStoredSession,
  api,
  getSessionVersion,
  getToken,
  setToken,
} from '../lib/apiClient.js'

const state = reactive({
  token: getToken(),
  user: null,
  initialized: false,
  loading: false,
  initError: '',
  sessionEpoch: 0,
  sessionChanging: false,
})

let initPromise = null
let authenticationVersion = 0

function assertCurrentSession(version) {
  if (version !== getSessionVersion()) {
    throw new ApiError('登录状态已变更，请重新操作', 409, { code: 'SESSION_CHANGED' })
  }
}

async function loadMe() {
  const version = getSessionVersion()
  const result = await api('/api/auth/me')
  assertCurrentSession(version)
  if (!result?.user?.id && !result?.id) throw new ApiError('无法读取账号资料，请重试', 502)
  state.user = result?.user || result
  state.token = getToken()
  return state.user
}

async function init(force = false) {
  getSessionVersion()
  if (state.sessionChanging && !force) return
  if (state.initialized && !force) return
  if (initPromise) return initPromise
  const attempt = authenticationVersion
  const currentInit = (async () => {
    const version = getSessionVersion()
    state.token = getToken()
    state.initError = ''
    if (state.token) {
      try {
        await loadMe()
      } catch (error) {
        if (version !== getSessionVersion() || attempt !== authenticationVersion) return
        // A temporary failure does not prove the saved session is invalid.
        // Keep it so the user can retry after the server/network recovers.
        if (error.status === 401 || error.status === 403) logout()
        else state.initError = error.message
      }
    }
    if (attempt === authenticationVersion) state.initialized = true
  })()
  initPromise = currentInit
  try {
    await currentInit
  } finally {
    if (initPromise === currentInit) initPromise = null
  }
}

async function authenticate(endpoint, payload) {
  const previousSession = getSessionVersion()
  if (state.sessionChanging) {
    throw new ApiError('登录状态正在同步，请稍后重试', 409, { code: 'SESSION_CHANGED' })
  }
  if (state.loading) return
  const attempt = ++authenticationVersion
  state.loading = true
  state.initError = ''
  try {
    const result = await api(endpoint, { method: 'POST', body: payload, auth: false })
    assertCurrentSession(previousSession)
    if (attempt !== authenticationVersion) throw new ApiError('登录操作已取消，请重试', 409)
    if (typeof result?.token !== 'string' || !result.token) throw new ApiError('登录响应不完整，请重试', 502)
    setToken(result.token)
    state.token = result.token
    state.user = result.user || null
    try {
      if (!state.user) await loadMe()
    } catch (error) {
      if (attempt === authenticationVersion && getToken()) state.initError = error.message
      throw error
    }
    state.initialized = true
  } finally {
    if (attempt === authenticationVersion) state.loading = false
  }
}

async function login(credentials) {
  return authenticate('/api/auth/login', credentials)
}
async function register(payload) {
  return authenticate('/api/auth/register', payload)
}

function logout() {
  authenticationVersion += 1
  state.token = ''
  state.user = null
  state.loading = false
  state.initError = ''
  state.initialized = true
  initPromise = null
  setToken('')
}

function storedSessionChanged() {
  authenticationVersion += 1
  initPromise = null
  state.token = getToken()
  state.user = null
  state.loading = false
  state.initError = ''
  state.initialized = false
  state.sessionChanging = true
  state.sessionEpoch += 1
}

async function resumeStoredSession(epoch) {
  const version = getSessionVersion()
  if (epoch !== state.sessionEpoch || !acceptStoredSession(version)) return false
  initPromise = null
  await init(true)
  getSessionVersion()
  return epoch === state.sessionEpoch
}

function finishStoredSession(epoch) {
  if (epoch === state.sessionEpoch) state.sessionChanging = false
}

function syncStoredToken(event) {
  if (event?.storageArea && event.storageArea !== localStorage) return
  if (event?.type === 'storage' && event.key != null && event.key !== TOKEN_KEY) return
  // Read the current storage value: queued events can already be out of date.
  getToken()
}

async function updateProfile(nickname) {
  const version = getSessionVersion()
  const result = await api('/api/auth/me', { method: 'PUT', body: { nickname } })
  assertCurrentSession(version)
  state.user = result.user
}

async function updateAvatar(file) {
  const version = getSessionVersion()
  const body = new FormData()
  body.append('file', file)
  const result = await api('/api/auth/me/avatar', { method: 'PUT', body })
  assertCurrentSession(version)
  state.user = result.user
}

async function removeAvatar() {
  const version = getSessionVersion()
  const result = await api('/api/auth/me/avatar', { method: 'DELETE' })
  assertCurrentSession(version)
  state.user = result.user
}

window.addEventListener('collab:unauthorized', logout)
window.addEventListener('collab:session-changed', storedSessionChanged)
window.addEventListener('collab:token-refreshed', () => {
  state.token = getToken()
})
window.addEventListener('storage', syncStoredToken)
window.addEventListener('focus', syncStoredToken)
globalThis.document?.addEventListener?.('visibilitychange', () => {
  if (document.visibilityState === 'visible') syncStoredToken()
})

export const authStore = {
  state,
  init,
  login,
  register,
  logout,
  resumeStoredSession,
  finishStoredSession,
  loadMe,
  updateProfile,
  updateAvatar,
  removeAvatar,
  isAuthenticated: computed(() => Boolean(state.token && state.user)),
  displayName: computed(() => state.user?.nickname || state.user?.username || '用户'),
}
