<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRouter } from 'vue-router'
import {
  ArrowLeft,
  ChevronDown,
  Download,
  FileText,
  History,
  LayoutDashboard,
  LockKeyhole,
  Menu,
  PanelTop,
  RotateCw,
  Users,
  X,
} from 'lucide-vue-next'
import ConnectionBadge from './ConnectionBadge.vue'
import DocumentList from './DocumentList.vue'
import HistoryDialog from './HistoryDialog.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import BoardEditor from '../editors/BoardEditor.vue'
import DocumentEditor from '../editors/DocumentEditor.vue'
import KanbanEditor from '../editors/KanbanEditor.vue'
import { useCollabSocket } from '../composables/useCollabSocket.js'
import { download } from '../lib/apiClient.js'
import { notify } from '../stores/toast.js'
import { authStore } from '../stores/auth.js'
import { activateFocusLayer } from '../lib/focusLayer.js'
import '../styles/workspace.css'

const props = defineProps({
  document: { type: Object, required: true },
  documents: { type: Array, default: () => [] },
  listLoading: { type: Boolean, default: false },
  listError: { type: String, default: '' },
  returnTo: { type: [Object, String], default: '/' },
})
const emit = defineEmits(['document-renamed', 'document-deleted', 'permission-updated', 'retry-list'])
const router = useRouter()
const title = computed(() => props.document.title || '未命名内容')
const historyOpen = ref(false)
const sidebarOpen = ref(false)
const exportFormat = ref('md')
const exporting = ref(false)
const sidebarElement = ref(null)
const mobile = ref(false)
const drawerOnTop = ref(false)
const drawerOpen = computed(() => mobile.value && sidebarOpen.value)
const confirmLeave = ref(false)
let mediaQuery = null
let drawerLayer = null
let drawerGeneration = 0
let resolveLeave = null
let leaveTimer = null

const docKey = props.document.doc_key || props.document.docKey
const kind = props.document.kind || 'doc'
const initialRole = props.document.my_role || props.document.myRole || 'viewer'
const collab = useCollabSocket({ docId: docKey, application: kind, initialRole })
const accessRevoked = computed(() => collab.status.value === 'closed' && !collab.retryAllowed.value)
watch(
  () => collab.role.value,
  (role) => emit('permission-updated', role),
)
watch(
  () => collab.metadata.value,
  (metadata) => {
    if (metadata?.docId === docKey) emit('document-renamed', { docKey, title: metadata.title })
  },
)
watch(accessRevoked, (revoked) => {
  if (revoked) {
    historyOpen.value = false
    emit('retry-list')
  }
})

const kindMeta = {
  doc: { name: '协同文档', icon: FileText },
  board: { name: '协同白板', icon: PanelTop },
  kanban: { name: '协同看板', icon: LayoutDashboard },
}
const roleNames = { owner: '所有者', admin: '所有者', editor: '编辑者', viewer: '只读者' }
const editorComponent = computed(
  () => ({ doc: DocumentEditor, board: BoardEditor, kanban: KanbanEditor })[kind],
)
const visibleMembers = computed(() => collab.members.value.slice(0, 4))
const exportFormats = computed(
  () =>
    ({
      doc: [
        ['md', 'Markdown'],
        ['docx', 'Word'],
        ['html', 'HTML'],
        ['txt', '纯文本'],
      ],
      board: [
        ['svg', 'SVG'],
        ['png', 'PNG'],
        ['md', 'Markdown'],
      ],
      kanban: [
        ['csv', 'CSV'],
        ['xlsx', 'XLSX'],
        ['md', 'Markdown'],
      ],
    })[kind],
)
exportFormat.value = exportFormats.value[0][0]

function openDocument(document) {
  sidebarOpen.value = false
  router.push({
    name: 'workspace',
    params: { kind: document.kind || 'doc', docKey: document.doc_key || document.docKey },
  })
}

async function exportMarkdown() {
  if (exporting.value || accessRevoked.value) return
  if (collab.pendingCount.value) return notify('请等待修改同步完成后再导出', 'info')
  exporting.value = true
  try {
    await download(
      `/api/docs/${encodeURIComponent(docKey)}/export?format=${exportFormat.value}`,
      `${title.value}.${exportFormat.value}`,
    )
    notify('内容已导出', 'success')
  } catch (error) {
    notify(error.message, 'error')
  } finally {
    exporting.value = false
  }
}

function displayMember(member) {
  return member.displayName || member.hostname || '在线成员'
}

function updateViewport() {
  mobile.value = mediaQuery.matches
  if (!mobile.value) sidebarOpen.value = false
}

watch(drawerOpen, async (opened) => {
  const generation = ++drawerGeneration
  drawerLayer?.release({ restoreFocus: mobile.value })
  drawerLayer = null
  if (!opened) return
  const returnFocusTo = window.document.activeElement
  await nextTick()
  if (generation !== drawerGeneration || !drawerOpen.value || !sidebarElement.value) return
  drawerLayer = activateFocusLayer(sidebarElement.value, {
    returnFocusTo,
    onEscape: () => {
      sidebarOpen.value = false
    },
    onTopChange: (active) => {
      drawerOnTop.value = active
    },
  })
})

function finishLeave(leave) {
  clearTimeout(leaveTimer)
  confirmLeave.value = false
  const resolve = resolveLeave
  resolveLeave = null
  resolve?.(leave)
}

function guardPendingEdits() {
  if (!authStore.isAuthenticated.value || !collab.pendingCount.value) return true
  if (resolveLeave) return false
  return new Promise((resolve) => {
    resolveLeave = resolve
    leaveTimer = setTimeout(() => {
      if (!collab.pendingCount.value) finishLeave(true)
      else confirmLeave.value = true
    }, 180)
  })
}

watch(
  () => collab.pendingCount.value,
  (count) => {
    if (count === 0 && resolveLeave) finishLeave(true)
  },
)
onBeforeRouteLeave(guardPendingEdits)
onBeforeRouteUpdate(guardPendingEdits)

function beforeUnload(event) {
  if (!collab.pendingCount.value) return
  event.preventDefault()
  event.returnValue = ''
}

onMounted(() => {
  mediaQuery = window.matchMedia('(max-width: 820px)')
  updateViewport()
  mediaQuery.addEventListener('change', updateViewport)
  window.addEventListener('beforeunload', beforeUnload)
})
onBeforeUnmount(() => {
  drawerGeneration++
  drawerLayer?.release({ restoreFocus: false })
  mediaQuery?.removeEventListener('change', updateViewport)
  window.removeEventListener('beforeunload', beforeUnload)
  finishLeave(false)
})
</script>

<template>
  <div class="workspace-layout" :class="`workspace-${kind}`">
    <div v-if="drawerOpen" class="mobile-overlay" aria-hidden="true" @click="sidebarOpen = false" />
    <aside
      ref="sidebarElement"
      class="workspace-sidebar"
      :class="{ open: drawerOpen }"
      :inert="mobile && (!drawerOpen || !drawerOnTop)"
      :role="drawerOpen ? 'dialog' : undefined"
      :aria-modal="drawerOpen && drawerOnTop ? true : undefined"
      aria-label="空间内容导航"
      tabindex="-1"
    >
      <div class="workspace-sidebar-head">
        <button
          class="icon-button"
          type="button"
          aria-label="返回工作台"
          title="返回工作台"
          @click="router.push(returnTo)"
        >
          <ArrowLeft :size="19" />
        </button>
        <div>
          <strong>{{ document.space_name || '空间内容' }}</strong
          ><small>{{ listLoading ? '正在加载内容列表' : `${documents.length} 个内容` }}</small>
        </div>
        <button
          class="icon-button sidebar-close"
          type="button"
          aria-label="关闭内容列表"
          @click="sidebarOpen = false"
        >
          <X :size="18" />
        </button>
      </div>
      <div v-if="listError && !accessRevoked" class="workspace-list-error" role="alert">
        <p>内容列表暂时不可用，当前内容可继续查看。</p>
        <button class="button secondary" type="button" :disabled="listLoading" @click="$emit('retry-list')">
          <RotateCw :size="14" />重试列表
        </button>
      </div>
      <DocumentList
        v-if="!listError || documents.length"
        :documents="documents"
        :loading="listLoading && !documents.length"
        :active-key="docKey"
        compact
        @open="openDocument"
        @renamed="$emit('document-renamed', $event)"
        @deleted="$emit('document-deleted', $event)"
      />
    </aside>

    <main class="workspace-main" :inert="drawerOpen">
      <header class="workspace-topbar">
        <button
          class="icon-button menu-button"
          type="button"
          aria-label="打开内容列表"
          @click="sidebarOpen = true"
        >
          <Menu :size="20" />
        </button>
        <span class="workspace-kind"
          ><component :is="kindMeta[kind].icon" :size="17" />{{ kindMeta[kind].name }}</span
        >
        <div class="workspace-title-field">
          <h1 class="workspace-title" aria-label="内容标题" :title="title">{{ title }}</h1>
        </div>
        <span class="role-badge" :class="{ readonly: collab.role.value === 'viewer' }">{{
          roleNames[collab.role.value] || collab.role.value
        }}</span>
        <ConnectionBadge :status="collab.status.value" :pending-count="collab.pendingCount.value" />
        <div class="online-members" :title="`${collab.members.value.length} 个在线连接`">
          <span
            v-for="member in visibleMembers"
            :key="member.clientId"
            class="online-avatar"
            :aria-label="displayMember(member)"
            >{{ displayMember(member).slice(0, 1) }}</span
          >
          <span class="online-count"><Users :size="15" />{{ collab.members.value.length }}</span>
        </div>
        <div class="workspace-actions" role="group" aria-label="内容工具">
          <button
            class="button workspace-history"
            type="button"
            aria-label="历史"
            title="版本历史"
            :disabled="collab.pendingCount.value > 0 || accessRevoked"
            @click="historyOpen = true"
          >
            <History :size="16" /><span>历史</span>
          </button>
          <div class="workspace-export-group" role="group" aria-label="导出内容">
            <div class="workspace-format-field">
              <select v-model="exportFormat" aria-label="导出格式" title="选择导出格式" :disabled="exporting">
                <option v-for="format in exportFormats" :key="format[0]" :value="format[0]">
                  {{ format[1] }}
                </option>
              </select>
              <ChevronDown :size="14" aria-hidden="true" />
            </div>
            <button
              class="button workspace-export-button"
              type="button"
              :aria-label="exporting ? '导出中' : '导出'"
              title="导出当前内容"
              :disabled="exporting || collab.pendingCount.value > 0 || accessRevoked"
              @click="exportMarkdown"
            >
              <Download :size="16" /><span>{{ exporting ? '导出中' : '导出' }}</span>
            </button>
          </div>
        </div>
      </header>

      <div v-if="collab.error.value && !accessRevoked" class="connection-alert" role="alert">
        {{ collab.error.value }}
      </div>
      <div v-if="!collab.connected.value && !accessRevoked" class="offline-strip">
        <span>{{
          collab.pendingCount.value
            ? `还有 ${collab.pendingCount.value} 项修改等待同步，请保持页面打开。`
            : '实时连接未就绪，连接恢复后可继续编辑。'
        }}</span>
        <button
          v-if="collab.status.value === 'closed' && collab.retryAllowed.value"
          type="button"
          @click="collab.retry()"
        >
          <RotateCw :size="13" />重新连接
        </button>
      </div>
      <div v-else-if="collab.role.value === 'viewer' && !accessRevoked" class="readonly-strip">
        当前以只读角色查看，编辑与恢复操作不可用
      </div>

      <section v-if="accessRevoked" class="workspace-unavailable" role="alert">
        <LockKeyhole :size="30" aria-hidden="true" />
        <h2>当前内容已无法访问</h2>
        <p>{{ collab.error.value }}</p>
        <button class="button primary" type="button" @click="router.push(returnTo)">
          <ArrowLeft :size="16" />返回工作台
        </button>
      </section>
      <component :is="editorComponent" v-else :collab="collab" />
    </main>

    <HistoryDialog
      v-if="historyOpen"
      :doc-key="docKey"
      :kind="kind"
      :can-restore="collab.canEdit.value"
      :live-revision="collab.revision.value"
      @close="historyOpen = false"
      @restored="collab.reloadSnapshot"
    />
    <ConfirmDialog
      v-if="confirmLeave"
      title="修改还没有同步完成"
      description="可以取消并等待同步；立即离开可能丢失尚未确认的修改。同步完成后会自动前往目标页面。"
      confirm-label="仍然离开"
      danger
      @cancel="finishLeave(false)"
      @confirm="finishLeave(true)"
    />
  </div>
</template>
