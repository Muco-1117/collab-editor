import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dismiss, notify, pauseToast, resumeToast, toasts } from '../stores/toast.js'

describe('bounded, readable notifications', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {
      setTimeout: (...args) => setTimeout(...args),
      clearTimeout: (id) => clearTimeout(id),
    })
  })
  afterEach(() => {
    for (const toast of [...toasts]) dismiss(toast.id)
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('merges identical messages and restarts their lifetime without adding rows', () => {
    const first = notify('服务器暂时不可用', 'error', 1000)
    vi.advanceTimersByTime(700)
    expect(notify('服务器暂时不可用', 'error', 1000)).toBe(first)
    expect(toasts).toHaveLength(1)
    vi.advanceTimersByTime(700)
    expect(toasts).toHaveLength(1)
    vi.advanceTimersByTime(300)
    expect(toasts).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shows at most the latest three different notices and clears removed timers', () => {
    for (let index = 0; index < 12; index++) notify(`提示 ${index}`, 'info', 1000)
    expect(toasts.map((toast) => toast.message)).toEqual(['提示 9', '提示 10', '提示 11'])
    expect(vi.getTimerCount()).toBe(3)
    vi.advanceTimersByTime(1000)
    expect(toasts).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps separate pause reasons and only resumes after hover and focus both leave', () => {
    const id = notify('阅读较长的提示', 'info', 1000)
    vi.advanceTimersByTime(400)
    pauseToast(id, 'hover')
    pauseToast(id, 'focus')
    pauseToast(id, 'hover')
    vi.advanceTimersByTime(5000)
    resumeToast(id, 'hover')
    vi.advanceTimersByTime(5000)
    expect(toasts).toHaveLength(1)
    resumeToast(id, 'focus')
    vi.advanceTimersByTime(599)
    expect(toasts).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(toasts).toHaveLength(0)
  })

  it('refreshes a paused duplicate without prematurely restarting its timer', () => {
    const id = notify('网络失败', 'error', 1000)
    vi.advanceTimersByTime(900)
    pauseToast(id, 'focus')
    notify('网络失败', 'error', 1500)
    vi.advanceTimersByTime(9000)
    expect(toasts).toHaveLength(1)
    resumeToast(id, 'focus')
    vi.advanceTimersByTime(1499)
    expect(toasts).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(toasts).toHaveLength(0)
  })

  it('supports manual dismissal without pending callbacks or duplicate focus events', () => {
    const id = notify('完成', 'success')
    pauseToast(id, 'hover')
    dismiss(id)
    resumeToast(id, 'hover')
    dismiss(id)
    expect(toasts).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not create empty messages and normalizes unsupported types', () => {
    expect(notify('   ')).toBeNull()
    notify(' 普通提示 ', 'unexpected')
    notify(' 普通提示 ', 'success')
    expect(toasts.map(({ message, type }) => ({ message, type }))).toEqual([
      { message: '普通提示', type: 'info' },
      { message: '普通提示', type: 'success' },
    ])
  })
})
