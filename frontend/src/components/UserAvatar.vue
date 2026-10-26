<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { apiBlob } from '../lib/apiClient.js'

const props = defineProps({ name: { type: String, default: '用户' }, source: { type: String, default: '' } })
const image = ref('')
const initial = computed(() => Array.from(props.name.trim() || '用')[0].toUpperCase())
let generation = 0
let request
function clear() {
  if (image.value) URL.revokeObjectURL(image.value)
  image.value = ''
}
watch(
  () => props.source,
  async (source) => {
    const current = ++generation
    request?.abort()
    clear()
    if (!source || !/^\/api\/users\/\d+\/avatar(?:\?|$)/.test(source)) return
    request = new AbortController()
    try {
      const blob = await apiBlob(source, { signal: request.signal })
      if (current === generation) image.value = URL.createObjectURL(blob)
    } catch {
      /* 网络不可用时显示昵称首字。 */
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  generation++
  request?.abort()
  clear()
})
</script>

<template>
  <span class="avatar user-avatar" role="img" :aria-label="`${name}的头像`">
    <img v-if="image" :src="image" alt="" draggable="false" @error="clear" />
    <span v-else aria-hidden="true">{{ initial }}</span>
  </span>
</template>
