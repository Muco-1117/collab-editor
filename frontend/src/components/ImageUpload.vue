<script setup>
import { onBeforeUnmount, ref, watch } from 'vue'
import { ImagePlus } from 'lucide-vue-next'
import { api } from '../lib/apiClient.js'
import { notify } from '../stores/toast.js'
const props = defineProps({
  docId: { type: String, required: true },
  label: { type: String, default: '插入图片' },
  disabled: Boolean,
})
const emit = defineEmits(['uploaded'])
const input = ref(null)
const uploading = ref(false)
let controller = null
let generation = 0

function cancelUpload() {
  generation += 1
  controller?.abort()
  controller = null
  uploading.value = false
}

watch(() => [props.docId, props.disabled], cancelUpload)
onBeforeUnmount(cancelUpload)

async function upload(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file || uploading.value || props.disabled) return
  if (!['image/png', 'image/jpeg', 'image/gif'].includes(file.type))
    return notify('仅支持 PNG、JPEG、GIF 图片', 'error')
  if (!file.size) return notify('图片文件为空，请重新选择', 'error')
  if (file.size > 8 * 1024 * 1024) return notify('图片大小不能超过 8MB', 'error')
  const current = ++generation
  const docId = props.docId
  controller = new AbortController()
  uploading.value = true
  try {
    const body = new FormData()
    body.append('file', file)
    const result = await api(`/api/docs/${encodeURIComponent(docId)}/images`, {
      method: 'POST',
      body,
      signal: controller.signal,
    })
    if (current === generation && props.docId === docId && !props.disabled) emit('uploaded', result)
  } catch (error) {
    if (current === generation && error.name !== 'AbortError') notify(error.message, 'error')
  } finally {
    if (current === generation) {
      uploading.value = false
      controller = null
    }
  }
}
</script>
<template>
  <span class="image-upload-control">
    <input
      ref="input"
      type="file"
      accept="image/png,image/jpeg,image/gif"
      hidden
      :aria-label="label"
      :disabled="disabled || uploading"
      @change="upload"
    />
    <button class="button secondary" type="button" :disabled="disabled || uploading" @click="input.click()">
      <ImagePlus :size="16" />{{ uploading ? '正在上传…' : label }}
    </button>
  </span>
</template>
