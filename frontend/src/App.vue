<script setup>
import { nextTick, onBeforeUnmount, onMounted, watch } from 'vue'
import { RouterView } from 'vue-router'
import { useRoute, useRouter } from 'vue-router'
import ToastHost from './components/ToastHost.vue'
import { authStore } from './stores/auth.js'
import { dismiss, toasts } from './stores/toast.js'

const router = useRouter()
const route = useRoute()

function handleUnauthorized() {
  const redirect = route.name === 'login' ? undefined : route.fullPath
  router.replace({ name: 'login', query: redirect ? { redirect } : {} })
}

onMounted(() => window.addEventListener('collab:unauthorized', handleUnauthorized))
onBeforeUnmount(() => window.removeEventListener('collab:unauthorized', handleUnauthorized))

watch(
  () => authStore.state.sessionEpoch,
  async (epoch) => {
    if (!authStore.state.sessionChanging) return
    const redirect = route.name === 'login' ? route.query.redirect : route.fullPath
    // Tear down sockets, drafts and modal guards before accepting another
    // account's credentials. A routine token refresh never enters this path.
    for (const toast of [...toasts]) dismiss(toast.id)
    await nextTick()
    if (!(await authStore.resumeStoredSession(epoch))) return
    try {
      if (authStore.isAuthenticated.value) {
        await router.replace({ name: 'dashboard' })
      } else {
        await router.replace({
          name: 'login',
          query: typeof redirect === 'string' ? { redirect } : {},
        })
      }
    } finally {
      authStore.finishStoredSession(epoch)
    }
  },
  { immediate: true },
)
</script>

<template>
  <div v-if="authStore.state.sessionChanging" class="page-loading" role="status" aria-live="polite">
    <span>正在同步登录状态</span>
  </div>
  <RouterView v-else :key="authStore.state.sessionEpoch" />
  <ToastHost />
</template>
