<script setup>
import { computed, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Eye, EyeOff, FolderKanban, LoaderCircle, LogIn, RotateCw } from 'lucide-vue-next'
import { authStore } from '../stores/auth.js'
import '../styles/auth.css'

const router = useRouter()
const route = useRoute()
const mode = ref('login')
const showPassword = ref(false)
const error = ref('')
const resuming = ref(false)
const form = reactive({ username: '', password: '', nickname: '' })
const title = computed(() => (mode.value === 'login' ? '登录' : '创建账号'))
const busy = computed(() => authStore.state.loading || resuming.value)

function destination() {
  return typeof route.query.redirect === 'string' && /^\/(?!\/)/.test(route.query.redirect)
    ? route.query.redirect
    : '/'
}

async function retrySession() {
  if (busy.value) return
  resuming.value = true
  error.value = ''
  try {
    await authStore.init(true)
    if (authStore.isAuthenticated.value) await router.replace(destination())
  } finally {
    resuming.value = false
  }
}

function switchMode(next) {
  if (busy.value) return
  mode.value = next
  showPassword.value = false
  error.value = ''
}

async function submit() {
  if (busy.value) return
  error.value = ''
  const username = form.username.trim()
  if (!username || !form.password) {
    error.value = '请输入用户名和密码'
    return
  }
  if (mode.value === 'register' && !/^[A-Za-z0-9_-]{3,32}$/.test(username)) {
    error.value = '用户名需为 3-32 位字母、数字、下划线或连字符'
    return
  }
  if (
    mode.value === 'register' &&
    (form.password.length < 6 || new TextEncoder().encode(form.password).length > 72)
  ) {
    error.value = '密码至少 6 位，不能超过 72 字节（汉字通常占 3 字节）'
    return
  }
  try {
    if (mode.value === 'login') await authStore.login({ username, password: form.password })
    else await authStore.register({ username, password: form.password, nickname: form.nickname.trim() })
    await router.replace(destination())
  } catch (requestError) {
    error.value = requestError.message
  }
}
</script>

<template>
  <main class="auth-page">
    <section class="auth-panel" aria-labelledby="auth-title">
      <header class="auth-brand">
        <span class="auth-workbench-mark" aria-hidden="true"><FolderKanban :size="23" /></span>
        <div>
          <strong>协同工作台</strong>
          <span>多人实时协同编辑系统</span>
        </div>
      </header>

      <div class="auth-heading">
        <h1 id="auth-title">{{ title }}</h1>
        <p>{{ mode === 'login' ? '进入你的协同空间' : '注册后将自动创建默认空间' }}</p>
      </div>

      <div v-if="authStore.state.initError && authStore.state.token" class="auth-retry" role="alert">
        <p>暂时无法恢复登录状态</p>
        <small>{{ authStore.state.initError }}</small>
        <button class="button secondary" type="button" :disabled="busy" @click="retrySession">
          <RotateCw :size="14" />{{ resuming ? '正在重试' : '重试连接' }}
        </button>
      </div>

      <div class="segmented auth-switch" aria-label="认证方式">
        <button
          type="button"
          :disabled="busy"
          :aria-pressed="mode === 'login'"
          :class="{ active: mode === 'login' }"
          @click="switchMode('login')"
        >
          登录
        </button>
        <button
          type="button"
          :disabled="busy"
          :aria-pressed="mode === 'register'"
          :class="{ active: mode === 'register' }"
          @click="switchMode('register')"
        >
          注册
        </button>
      </div>

      <form class="auth-form" @submit.prevent="submit">
        <label>
          <span>用户名</span>
          <input
            v-model="form.username"
            :disabled="busy"
            name="username"
            autocomplete="username"
            maxlength="32"
            placeholder="请输入用户名"
            autofocus
          />
        </label>
        <label v-if="mode === 'register'">
          <span>昵称 <small>可选</small></span>
          <input
            v-model="form.nickname"
            :disabled="busy"
            name="nickname"
            autocomplete="nickname"
            maxlength="32"
            placeholder="用于成员列表展示"
          />
        </label>
        <label>
          <span>密码</span>
          <span class="password-field">
            <input
              v-model="form.password"
              :disabled="busy"
              :type="showPassword ? 'text' : 'password'"
              name="password"
              :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
              maxlength="72"
              placeholder="请输入密码"
            />
            <button
              class="icon-button subtle"
              type="button"
              :disabled="busy"
              :aria-label="showPassword ? '隐藏密码' : '显示密码'"
              @click="showPassword = !showPassword"
            >
              <EyeOff v-if="showPassword" :size="18" /><Eye v-else :size="18" />
            </button>
          </span>
        </label>
        <p v-if="mode === 'register'" class="auth-help">
          用户名使用 3–32 位字母、数字、下划线或连字符；密码至少 6 位，最多 72 字节（汉字通常占 3 字节）。
        </p>

        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <button class="button primary auth-submit" type="submit" :disabled="busy">
          <LoaderCircle v-if="authStore.state.loading" class="spin" :size="18" />
          <LogIn v-else :size="18" />
          {{ authStore.state.loading ? '正在提交' : title }}
        </button>
      </form>
    </section>
  </main>
</template>
