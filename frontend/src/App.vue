<script setup>
import { ref, onMounted } from 'vue'

const health = ref(null)
const error = ref('')

onMounted(async () => {
  try {
    const resp = await fetch('/api/health')
    health.value = await resp.json()
  } catch (e) {
    error.value = String(e)
  }
})
</script>

<template>
  <main style="font-family: system-ui, sans-serif; padding: 40px; max-width: 640px; margin: 0 auto">
    <h1>多人实时协同编辑系统</h1>
    <p style="color: #666">脚手架已就绪 —— 文档 / 白板 / 看板三应用入口与协同引擎将在后续里程碑接入。</p>
    <div v-if="health" style="border: 1px solid #ccc; border-radius: 8px; padding: 12px 16px; background: #f6f6f6">
      <div><strong>后端状态：</strong><span style="color: #0a7d33">{{ health.status }}</span></div>
      <div><strong>引擎：</strong>{{ health.engine }}</div>
      <div><strong>时间：</strong>{{ health.time }}</div>
    </div>
    <p v-if="error" style="color: #b02a2a">连接后端失败：{{ error }}</p>
  </main>
</template>