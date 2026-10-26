<script setup>
import { CircleAlert, Cloud, CloudOff, LoaderCircle } from 'lucide-vue-next'
import { computed } from 'vue'

const props = defineProps({
  status: { type: String, required: true },
  pendingCount: { type: Number, default: 0 },
})
const meta = computed(() => {
  if (props.status === 'connected' && props.pendingCount > 0) {
    return { label: `同步中 · ${props.pendingCount}`, icon: LoaderCircle, tone: 'pending' }
  }
  return ({
    connected: { label: '已连接', icon: Cloud, tone: 'success' },
    connecting: { label: '连接中', icon: LoaderCircle, tone: 'pending' },
    reconnecting: { label: '重新连接', icon: LoaderCircle, tone: 'pending' },
    closed: { label: '已离线', icon: CloudOff, tone: 'danger' },
  }[props.status] || { label: '连接异常', icon: CircleAlert, tone: 'danger' })
})
</script>

<template>
  <span class="connection-badge" :class="`connection-${meta.tone}`" role="status">
    <component :is="meta.icon" :size="15" :class="{ spin: meta.tone === 'pending' }" aria-hidden="true" />
    {{ meta.label }}
  </span>
</template>
