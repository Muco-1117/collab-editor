<script setup>
import { onBeforeUnmount, ref, watch } from 'vue'
import { apiBlob } from '../lib/apiClient.js'
const props = defineProps({
  assetId: { type: String, default: '' },
  alt: { type: String, default: '协同图片' },
  retryable: { type: Boolean, default: true },
})
const source = ref('')
const failed = ref(false)
let generation = 0
let controller = null
function clear() {
  if (source.value) URL.revokeObjectURL(source.value)
  source.value = ''
}
async function loadImage() {
  const id = props.assetId
  const current = ++generation
  controller?.abort()
  controller = null
  clear()
  failed.value = false
  if (!id) return
  controller = new AbortController()
  try {
    const blob = await apiBlob(`/api/assets/${encodeURIComponent(id)}`, { signal: controller.signal })
    if (current === generation) source.value = URL.createObjectURL(blob)
  } catch (error) {
    if (current === generation && error.name !== 'AbortError') failed.value = true
  } finally {
    if (current === generation) controller = null
  }
}
function imageFailed() {
  clear()
  failed.value = true
}
watch(() => props.assetId, loadImage, { immediate: true })
onBeforeUnmount(() => {
  generation++
  controller?.abort()
  clear()
})
</script>
<template>
  <img v-if="source" :src="source" :alt="alt" draggable="false" @error="imageFailed" />
  <span v-else class="asset-placeholder" role="status">
    <template v-if="failed">
      图片无法加载
      <button
        v-if="retryable"
        type="button"
        class="asset-retry"
        :aria-label="`重新加载图片：${alt}`"
        @pointerdown.stop
        @click.stop="loadImage"
      >
        重试
      </button>
    </template>
    <template v-else>{{ assetId ? '正在加载图片…' : '未设置图片' }}</template>
  </span>
</template>

<style scoped>
.asset-placeholder {
  gap: 8px;
}
.asset-retry {
  padding: 3px 6px;
  border: 0;
  border-radius: 4px;
  color: #4263eb;
  background: #eef2ff;
  font-size: 12px;
  cursor: pointer;
}
</style>
