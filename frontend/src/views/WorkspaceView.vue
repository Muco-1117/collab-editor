<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowLeft, LoaderCircle, RotateCw, TriangleAlert } from 'lucide-vue-next'
import WorkspaceSession from '../components/WorkspaceSession.vue'
import { api } from '../lib/apiClient.js'
import { readWorkbenchReturn } from '../lib/workbenchNavigation.js'
import { authStore } from '../stores/auth.js'
import { createLatestRequestGate } from '../lib/requestGate.js'
import { recordRecentWork } from '../lib/recentWork.js'

const props = defineProps({
  kind: { type: String, required: true },
  docKey: { type: String, required: true },
})
const router = useRouter()
const rememberedReturn = readWorkbenchReturn(authStore.state.user?.id)
const document = ref(null)
const documents = ref([])
const loading = ref(true)
const error = ref('')
const listLoading = ref(false)
const listError = ref('')
const contentRequests = createLatestRequestGate()
const listRequests = createLatestRequestGate()
let contentController = null
let listController = null
const returnTo = computed(() => {
  const spaceId = document.value?.space_id ?? document.value?.spaceId
  return rememberedReturn.query?.space || !spaceId
    ? rememberedReturn
    : { ...rememberedReturn, query: { ...rememberedReturn.query, space: String(spaceId) } }
})

async function loadDocumentList() {
  const spaceId = document.value?.space_id ?? document.value?.spaceId
  if (spaceId == null) return
  const request = listRequests.begin()
  listController?.abort()
  const controller = new AbortController()
  listController = controller
  listLoading.value = true
  listError.value = ''
  try {
    const rows = await api(`/api/docs?spaceId=${encodeURIComponent(spaceId)}`, { signal: controller.signal })
    if (listRequests.isCurrent(request)) {
      const role = document.value?.my_role || document.value?.myRole
      documents.value = (rows || []).map((row) => ({
        ...row,
        ...(role ? { my_role: role } : {}),
        ...((row.doc_key || row.docKey) === props.docKey ? { title: document.value.title } : {}),
      }))
    }
  } catch (requestError) {
    if (listRequests.isCurrent(request)) {
      listError.value = requestError.message
      if ([403, 404].includes(requestError.status)) documents.value = []
    }
  } finally {
    if (listRequests.isCurrent(request)) listLoading.value = false
  }
}

async function load() {
  const request = contentRequests.begin()
  const docKey = props.docKey
  const kind = props.kind
  contentController?.abort()
  listController?.abort()
  listRequests.invalidate()
  const controller = new AbortController()
  contentController = controller
  loading.value = true
  error.value = ''
  document.value = null
  documents.value = []
  listError.value = ''
  listLoading.value = false
  try {
    const metadata = await api(`/api/docs/${encodeURIComponent(docKey)}`, { signal: controller.signal })
    if (!contentRequests.isCurrent(request)) return
    const actualKind = metadata.kind || 'doc'
    if (actualKind !== kind) {
      await router.replace({ name: 'workspace', params: { kind: actualKind, docKey } })
      return
    }
    document.value = metadata
    recordRecentWork(authStore.state.user?.id, metadata)
    loadDocumentList()
  } catch (requestError) {
    if (contentRequests.isCurrent(request)) error.value = requestError.message
  } finally {
    if (contentRequests.isCurrent(request)) loading.value = false
  }
}

function renamedDocument(result) {
  const item = documents.value.find((row) => (row.doc_key || row.docKey) === result.docKey)
  if (item) item.title = result.title
  if (result.docKey === props.docKey && document.value) document.value.title = result.title
}

function permissionUpdated(role) {
  if (document.value) document.value.my_role = role
  for (const row of documents.value) row.my_role = role
}

function deletedDocument(docKey) {
  documents.value = documents.value.filter((row) => (row.doc_key || row.docKey) !== docKey)
  if (docKey === props.docKey) {
    const next = documents.value[0]
    router.replace(
      next
        ? { name: 'workspace', params: { kind: next.kind || 'doc', docKey: next.doc_key || next.docKey } }
        : returnTo.value,
    )
  }
}

watch(() => [props.kind, props.docKey], load, { immediate: true })
onBeforeUnmount(() => {
  contentRequests.invalidate()
  listRequests.invalidate()
  contentController?.abort()
  listController?.abort()
})
</script>

<template>
  <div v-if="loading" class="page-loading">
    <LoaderCircle class="spin" :size="26" /><span>正在打开协同内容</span>
  </div>
  <main v-else-if="error" class="fatal-state">
    <TriangleAlert :size="30" />
    <h1>无法打开内容</h1>
    <p>{{ error }}</p>
    <div class="fatal-state-actions">
      <button class="button primary" type="button" @click="load"><RotateCw :size="17" />重试打开</button>
      <button class="button secondary" type="button" @click="router.push(returnTo)">
        <ArrowLeft :size="17" />返回工作台
      </button>
    </div>
  </main>
  <WorkspaceSession
    v-else-if="document"
    :key="docKey"
    :document="document"
    :documents="documents"
    :list-loading="listLoading"
    :list-error="listError"
    :return-to="returnTo"
    @retry-list="loadDocumentList"
    @document-renamed="renamedDocument"
    @permission-updated="permissionUpdated"
    @document-deleted="deletedDocument"
  />
</template>
