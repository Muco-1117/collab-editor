<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue'
import { FileText, LayoutDashboard, LoaderCircle, PanelTop, Search, X } from 'lucide-vue-next'
import { api } from '../lib/apiClient.js'
import { createLatestRequestGate } from '../lib/requestGate.js'

const emit = defineEmits(['open'])
const root = ref(null)
const input = ref(null)
const query = ref('')
const results = ref([])
const opened = ref(false)
const loading = ref(false)
const error = ref('')
const selected = ref(-1)
const composing = ref(false)
const listId = useId()
const requests = createLatestRequestGate()
const icons = { doc: FileText, board: PanelTop, kanban: LayoutDashboard }
const activeOption = computed(() => (selected.value < 0 ? undefined : `${listId}-${selected.value}`))
let timer
let controller = null

function dismiss() {
  requests.invalidate()
  window.clearTimeout(timer)
  controller?.abort()
  controller = null
  opened.value = false
  loading.value = false
  selected.value = -1
}

function clear() {
  query.value = ''
  results.value = []
  error.value = ''
  dismiss()
  input.value?.focus()
}

async function search(text, request) {
  const activeController = new AbortController()
  controller = activeController
  try {
    const rows = await api(`/api/docs/search?q=${encodeURIComponent(text)}`, {
      signal: activeController.signal,
    })
    if (!requests.isCurrent(request)) return
    const unique = new Map()
    for (const row of rows || []) {
      const key = row.doc_key || row.docKey
      if (!unique.has(key)) unique.set(key, row)
      else if (!unique.get(key).snippet && row.snippet)
        unique.set(key, { ...unique.get(key), snippet: row.snippet })
    }
    results.value = [...unique.values()]
  } catch (requestError) {
    if (requests.isCurrent(request)) error.value = requestError.message
  } finally {
    if (requests.isCurrent(request)) loading.value = false
    if (controller === activeController) controller = null
  }
}

function queue(immediate = false) {
  const request = requests.begin()
  window.clearTimeout(timer)
  controller?.abort()
  controller = null
  results.value = []
  selected.value = -1
  error.value = ''
  const text = query.value.trim()
  if (composing.value) {
    opened.value = false
    loading.value = false
    return
  }
  opened.value = Boolean(text)
  loading.value = Boolean(text)
  if (text) timer = window.setTimeout(() => search(text, request), immediate ? 0 : 300)
}

function startComposition() {
  composing.value = true
  dismiss()
  results.value = []
}

function finishComposition() {
  composing.value = false
  queue()
}

function focus() {
  if (query.value.trim() && !opened.value) queue(true)
}

function open(result) {
  dismiss()
  emit('open', result)
}

async function keydown(event) {
  if (event.isComposing || event.keyCode === 229 || composing.value) return
  if (event.key === 'Escape') {
    event.preventDefault()
    dismiss()
    return
  }
  if (event.key === 'Enter' && opened.value && selected.value >= 0 && results.value[selected.value]) {
    event.preventDefault()
    open(results.value[selected.value])
  }
  if (!['ArrowDown', 'ArrowUp'].includes(event.key) || !query.value.trim()) return
  event.preventDefault()
  if (!opened.value) {
    queue(true)
    return
  }
  if (!results.value.length) return
  selected.value =
    event.key === 'ArrowDown'
      ? (selected.value + 1) % results.value.length
      : (selected.value <= 0 ? results.value.length : selected.value) - 1
  await nextTick()
  document.getElementById(activeOption.value)?.scrollIntoView({ block: 'nearest' })
}

function outside(event) {
  if (!root.value?.contains(event.target)) dismiss()
}

function shortcut(event) {
  if (
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === 'k' &&
    !document.querySelector('[aria-modal="true"]')
  ) {
    event.preventDefault()
    input.value?.focus()
  }
}

onMounted(() => {
  document.addEventListener('pointerdown', outside)
  document.addEventListener('focusin', outside)
  document.addEventListener('keydown', shortcut)
})
onBeforeUnmount(() => {
  dismiss()
  document.removeEventListener('pointerdown', outside)
  document.removeEventListener('focusin', outside)
  document.removeEventListener('keydown', shortcut)
})
</script>

<template>
  <div ref="root" class="global-search">
    <Search :size="16" aria-hidden="true" />
    <input
      ref="input"
      v-model="query"
      role="combobox"
      aria-label="搜索当前可见内容"
      aria-autocomplete="list"
      :aria-expanded="opened"
      :aria-controls="opened ? listId : undefined"
      :aria-activedescendant="activeOption"
      autocomplete="off"
      maxlength="100"
      placeholder="搜索标题或正文"
      @input="queue()"
      @compositionstart="startComposition"
      @compositionend="finishComposition"
      @focus="focus"
      @keydown="keydown"
    />
    <button v-if="query" class="search-clear" type="button" aria-label="清空搜索" @click="clear">
      <X :size="14" />
    </button>
    <kbd v-else class="search-shortcut" aria-hidden="true">Ctrl K</kbd>
    <div v-if="opened" class="search-popover" @keydown.esc.prevent.stop="dismiss">
      <div class="search-popover-head">
        <strong
          >搜索结果 <span v-if="!loading && !error">{{ results.length }}</span></strong
        ><button class="icon-button subtle" type="button" aria-label="关闭搜索结果" @click="dismiss">
          <X :size="16" />
        </button>
      </div>
      <p v-if="loading" class="search-empty search-status" role="status">
        <LoaderCircle class="spin" :size="16" />正在搜索
      </p>
      <div v-else-if="error" class="search-error" role="alert">
        <span>{{ error }}</span
        ><button type="button" @click="queue(true)">重新搜索</button>
      </div>
      <div :id="listId" class="search-results" role="listbox" aria-label="搜索结果">
        <div
          v-for="(result, index) in results"
          :id="`${listId}-${index}`"
          :key="result.doc_key || result.docKey"
          class="search-result"
          :class="{ selected: selected === index }"
          role="option"
          :aria-selected="selected === index"
          @mousedown.prevent
          @click="open(result)"
        >
          <component :is="icons[result.kind] || FileText" :size="17" /><span
            ><strong>{{ result.title }}</strong
            ><small>{{ result.space_name }} · {{ result.hit === 'body' ? '正文命中' : '标题命中' }}</small
            ><em v-if="result.snippet">{{ result.snippet }}</em></span
          >
        </div>
      </div>
      <p v-if="!loading && !error && !results.length" class="search-empty" role="status">
        没有找到匹配内容，试试其他关键词
      </p>
      <p v-if="results.length" class="search-keyboard-hint" aria-hidden="true">
        ↑ ↓ 选择 <span>Enter 打开</span><span>Esc 关闭</span>
      </p>
    </div>
  </div>
</template>
