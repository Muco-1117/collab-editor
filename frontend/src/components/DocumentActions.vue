<script setup>
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import { AlertTriangle, Copy, ExternalLink, Link, Pencil, Trash2 } from 'lucide-vue-next'
import ActionMenu from './ActionMenu.vue'
import BaseModal from './BaseModal.vue'
import { api } from '../lib/apiClient.js'
import { authStore } from '../stores/auth.js'
import { notify } from '../stores/toast.js'

const props = defineProps({
  document: { type: Object, required: true },
  allowDelete: { type: Boolean, default: true },
})
const emit = defineEmits(['open', 'renamed', 'deleted'])
const renaming = ref(false)
const deleting = ref(false)
const title = ref('')
const busy = ref(false)
const error = ref('')
const composing = ref(false)
const copyOpen = ref(false)
const copying = ref(false)
const copyUrl = ref('')
const copyError = ref('')
const copyField = ref(null)
const target = ref(null)
const formId = useId()
const errorId = useId()
const docKey = computed(() => props.document.doc_key || props.document.docKey)
const role = computed(() => props.document.my_role || props.document.myRole || 'viewer')
const canWrite = computed(() => ['owner', 'admin', 'editor'].includes(role.value))
const canDelete = computed(() => props.allowDelete && ['owner', 'admin'].includes(role.value))
const changedTitle = computed(() => title.value.trim() !== String(props.document.title || '').trim())
const items = computed(() => [
  { key: 'open', label: '打开内容', icon: ExternalLink, disabled: busy.value },
  { key: 'link', label: '复制链接', icon: Link, disabled: busy.value || copying.value },
  ...(canWrite.value ? [{ key: 'rename', label: '重命名', icon: Pencil, disabled: busy.value }] : []),
  ...(canDelete.value
    ? [{ key: 'delete', label: '删除内容', icon: Trash2, danger: true, disabled: busy.value }]
    : []),
])

let active = true
let generation = 0
let copyGeneration = 0
let controller = null

// A completed request must still belong to this document. An expired login is
// allowed through so a mutation guard cannot trap the login page.
function allowNavigation() {
  return !busy.value || !authStore.isAuthenticated.value
}
onBeforeRouteLeave(allowNavigation)
onBeforeRouteUpdate(allowNavigation)

function stillCurrent(request, key) {
  return active && request === generation && key === docKey.value
}

function resetTarget() {
  generation += 1
  copyGeneration += 1
  controller?.abort()
  controller = null
  busy.value = false
  copying.value = false
  renaming.value = false
  deleting.value = false
  copyOpen.value = false
  composing.value = false
  target.value = null
  error.value = ''
}

watch(docKey, resetTarget)
onBeforeUnmount(() => {
  active = false
  resetTarget()
})

function makeLink(document) {
  const url = new URL(window.location.href)
  url.search = ''
  url.hash = `/work/${document.kind || 'doc'}/${encodeURIComponent(document.doc_key || document.docKey)}`
  return url.href
}

async function selectLink() {
  await nextTick()
  copyField.value?.focus()
  copyField.value?.select()
}

async function copyLink() {
  if (copying.value) return
  const request = ++copyGeneration
  const url = copyUrl.value
  copying.value = true
  copyError.value = ''
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
    await navigator.clipboard.writeText(url)
    if (!active || request !== copyGeneration) return
    copyOpen.value = false
    notify('链接已复制，空间成员可通过链接打开', 'success')
  } catch {
    if (!active || request !== copyGeneration) return
    copyError.value = '自动复制未成功，请选中下方链接后手动复制。'
    copyOpen.value = true
    await selectLink()
  } finally {
    if (active && request === copyGeneration) copying.value = false
  }
}

function closeCopy() {
  copyGeneration += 1
  copying.value = false
  copyOpen.value = false
}

function select(key) {
  if (busy.value) return
  if (key === 'open') emit('open', props.document)
  if ((key === 'rename' && canWrite.value) || (key === 'delete' && canDelete.value)) {
    target.value = { docKey: docKey.value, title: props.document.title || '未命名内容' }
    error.value = ''
    composing.value = false
    if (key === 'rename') {
      title.value = props.document.title || ''
      renaming.value = true
    } else deleting.value = true
  }
  if (key === 'link') {
    copyUrl.value = makeLink(props.document)
    copyLink()
  }
}

function closeMutation() {
  if (busy.value) return
  renaming.value = false
  deleting.value = false
  composing.value = false
  error.value = ''
}

function onTitleEnter(event) {
  if (event.isComposing || event.keyCode === 229 || composing.value) return
  event.preventDefault()
  rename()
}

async function rename() {
  const nextTitle = title.value.trim()
  if (busy.value || composing.value || !canWrite.value || !nextTitle || !changedTitle.value) return
  const key = target.value?.docKey
  if (!key || key !== docKey.value) return
  const request = ++generation
  const requestController = new AbortController()
  controller = requestController
  busy.value = true
  error.value = ''
  try {
    await api(`/api/docs/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: { title: nextTitle },
      signal: requestController.signal,
    })
    if (!stillCurrent(request, key)) return
    renaming.value = false
    emit('renamed', { docKey: key, title: nextTitle })
    notify('标题已更新', 'success')
  } catch (requestError) {
    if (stillCurrent(request, key) && requestError.name !== 'AbortError') error.value = requestError.message
  } finally {
    if (stillCurrent(request, key)) {
      busy.value = false
      controller = null
    }
  }
}

async function remove() {
  if (busy.value || !canDelete.value) return
  const key = target.value?.docKey
  if (!key || key !== docKey.value) return
  const request = ++generation
  const requestController = new AbortController()
  controller = requestController
  busy.value = true
  error.value = ''
  try {
    await api(`/api/docs/${encodeURIComponent(key)}`, { method: 'DELETE', signal: requestController.signal })
    if (!stillCurrent(request, key)) return
    deleting.value = false
    emit('deleted', key)
    notify('内容已移入回收站', 'success')
  } catch (requestError) {
    if (stillCurrent(request, key) && requestError.name !== 'AbortError') error.value = requestError.message
  } finally {
    if (stillCurrent(request, key)) {
      busy.value = false
      controller = null
    }
  }
}
</script>

<template>
  <ActionMenu :label="`更多操作：${document.title || '未命名内容'}`" :items="items" @select="select" />
  <BaseModal v-if="renaming" title="重命名内容" :close-disabled="busy" @close="closeMutation">
    <form :id="formId" class="modal-form" @submit.prevent="rename">
      <label>
        <span>标题</span>
        <input
          v-model="title"
          maxlength="256"
          :disabled="busy"
          autofocus
          :aria-invalid="error ? true : undefined"
          :aria-describedby="error ? errorId : undefined"
          @compositionstart="composing = true"
          @compositionend="composing = false"
          @keydown.enter="onTitleEnter"
        />
      </label>
      <p v-if="error" :id="errorId" class="document-action-error" role="alert">{{ error }}</p>
    </form>
    <template #footer>
      <button class="button secondary" type="button" :disabled="busy" @click="closeMutation">取消</button>
      <button
        class="button primary"
        type="submit"
        :form="formId"
        :disabled="busy || composing || !canWrite || !title.trim() || !changedTitle"
      >
        {{ busy ? '正在保存' : '保存' }}
      </button>
    </template>
  </BaseModal>
  <BaseModal v-if="deleting" title="删除内容" :close-disabled="busy" @close="closeMutation">
    <div class="confirm-content">
      <AlertTriangle :size="22" aria-hidden="true" />
      <p>确定删除“{{ target?.title }}”？内容会移入空间回收站，之后可以恢复。</p>
    </div>
    <p v-if="error" class="document-action-error" role="alert">{{ error }}</p>
    <template #footer>
      <button class="button secondary" type="button" :disabled="busy" @click="closeMutation">取消</button>
      <button class="button danger" type="button" :disabled="busy || !canDelete" @click="remove">
        {{ busy ? '正在处理' : '删除' }}
      </button>
    </template>
  </BaseModal>
  <BaseModal
    v-if="copyOpen"
    title="复制内容链接"
    description="空间成员可通过此链接打开内容。"
    @close="closeCopy"
  >
    <div class="document-link-form">
      <p v-if="copyError" class="document-copy-help" role="status">{{ copyError }}</p>
      <label
        ><span>内容链接</span
        ><input ref="copyField" :value="copyUrl" readonly autofocus @focus="$event.target.select()"
      /></label>
    </div>
    <template #footer>
      <button class="button secondary" type="button" @click="selectLink">选中链接</button>
      <button class="button primary" type="button" :disabled="copying" @click="copyLink">
        <Copy :size="15" />{{ copying ? '正在复制' : '重新复制' }}
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.document-action-error {
  margin: 0;
  color: #a33b32;
  font-size: 13px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.confirm-content + .document-action-error {
  margin-top: 14px;
}
.document-link-form {
  display: grid;
  gap: 14px;
}
.document-link-form label {
  display: grid;
  gap: 7px;
  font-size: 13px;
  font-weight: 600;
}
.document-link-form input {
  min-width: 0;
  width: 100%;
  font-size: 12px;
  font-weight: 400;
}
.document-copy-help {
  margin: 0;
  color: #707989;
  font-size: 13px;
  line-height: 1.6;
}
</style>
