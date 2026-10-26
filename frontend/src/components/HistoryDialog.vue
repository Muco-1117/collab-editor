<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import { Clock3, Eye, RotateCcw, RotateCw } from 'lucide-vue-next'
import BaseModal from './BaseModal.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import AssetImage from './AssetImage.vue'
import { api } from '../lib/apiClient.js'
import { notify } from '../stores/toast.js'
import { authStore } from '../stores/auth.js'
import { createLatestRequestGate } from '../lib/requestGate.js'
import {
  boardReplayStyle,
  cardsForHistoryColumn,
  historyValue,
  normalizeHistoryRevision,
  sortHistoryElements,
  visibleHistoryElements,
} from '../lib/historyPreview.js'

const props = defineProps({
  docKey: { type: String, required: true },
  kind: { type: String, required: true },
  canRestore: { type: Boolean, default: false },
  liveRevision: { type: Number, default: null },
})
const emit = defineEmits(['close', 'restored'])

const loading = ref(true)
const restoring = ref(false)
const timeline = ref([])
const currentRev = ref(0)
const selectedRev = ref(0)
const loadedRev = ref(null)
const revisionInput = ref('0')
const preview = ref([])
const previewLoading = ref(false)
const previewFailure = ref('')
const failure = ref('')
const confirmRestore = ref(false)
const restoreTargetRev = ref(null)
const restoreFailure = ref('')
const historyRequests = createLatestRequestGate()
const previewRequests = createLatestRequestGate()
let historyController = null
let previewController = null
const hasNewerRevision = computed(
  () => Number.isSafeInteger(props.liveRevision) && props.liveRevision > currentRev.value,
)

function close() {
  if (!restoring.value) emit('close')
}
function guardRestore() {
  return !authStore.isAuthenticated.value || !restoring.value
}
onBeforeRouteLeave(guardRestore)
onBeforeRouteUpdate(guardRestore)
onBeforeUnmount(() => {
  historyRequests.invalidate()
  previewRequests.invalidate()
  historyController?.abort()
  previewController?.abort()
})

const documentParagraphs = computed(() =>
  sortHistoryElements([
    ...visibleHistoryElements(preview.value, 'TEXT'),
    ...visibleHistoryElements(preview.value, 'IMAGE'),
  ]),
)
const boardCards = computed(() =>
  sortHistoryElements(
    [...visibleHistoryElements(preview.value, 'CARD'), ...visibleHistoryElements(preview.value, 'IMAGE')],
    'z',
  ),
)
const kanbanColumns = computed(() => sortHistoryElements(visibleHistoryElements(preview.value, 'COLUMN')))
const canRestoreLoadedRevision = computed(
  () =>
    props.canRestore &&
    !restoring.value &&
    !previewLoading.value &&
    loadedRev.value != null &&
    loadedRev.value === selectedRev.value &&
    loadedRev.value !== currentRev.value,
)

async function loadHistory() {
  if (restoring.value) return
  const request = historyRequests.begin()
  previewRequests.invalidate()
  historyController?.abort()
  previewController?.abort()
  historyController = new AbortController()
  loading.value = true
  failure.value = ''
  previewFailure.value = ''
  loadedRev.value = null
  const docKey = props.docKey
  try {
    const result = await api(`/api/docs/${encodeURIComponent(docKey)}/history?limit=200`, {
      signal: historyController.signal,
    })
    if (!historyRequests.isCurrent(request) || docKey !== props.docKey) return
    timeline.value = result.ops || []
    currentRev.value = Number(result.rev) || 0
    revisionInput.value = String(currentRev.value)
    await selectRevision(currentRev.value)
  } catch (requestError) {
    if (!historyRequests.isCurrent(request)) return
    failure.value = requestError.message
  } finally {
    if (historyRequests.isCurrent(request)) loading.value = false
  }
}

async function selectRevision(rev) {
  if (restoring.value) return
  const revision = normalizeHistoryRevision(rev, currentRev.value)
  if (revision == null) {
    notify(`版本号必须是 0 到 ${currentRev.value} 之间的整数`, 'error')
    return
  }
  const request = previewRequests.begin()
  previewController?.abort()
  previewController = new AbortController()
  const docKey = props.docKey
  selectedRev.value = revision
  revisionInput.value = String(revision)
  loadedRev.value = null
  previewLoading.value = true
  previewFailure.value = ''
  try {
    const result = await api(`/api/docs/${encodeURIComponent(docKey)}/replay?rev=${revision}`, {
      signal: previewController.signal,
    })
    if (!previewRequests.isCurrent(request) || docKey !== props.docKey) return
    const responseRevision = Number(result.rev)
    if (responseRevision !== revision || !Array.isArray(result.elements))
      throw new Error('版本预览数据不完整，请重试')
    preview.value = result.elements || []
    loadedRev.value = revision
  } catch (requestError) {
    if (!previewRequests.isCurrent(request)) return
    preview.value = []
    previewFailure.value = requestError.message
    notify(requestError.message, 'error')
  } finally {
    if (previewRequests.isCurrent(request)) previewLoading.value = false
  }
}

function jumpToRevision() {
  selectRevision(revisionInput.value)
}

function operationType(entry) {
  const raw = String(entry.clock || '')
  const type = raw.includes('|') ? raw.split('|')[0] : ''
  return { ADD: '创建', PUT: '修改', STATE: '更新状态', DELETE: '删除' }[type] || '操作'
}

function operationSubject(entry) {
  const type =
    { TEXT: '段落', IMAGE: '图片', CARD: '卡片', COLUMN: '列表', DOC: '文档' }[entry.element_type] || '元素'
  if (String(entry.clock || '').startsWith('STATE|')) return type
  return entry.field && entry.field !== '#tombstone' ? `${type} · ${entry.field}` : type
}

function operationActor(entry) {
  return entry.actor_name || (entry.actor_id ? `用户 ${entry.actor_id}` : '系统操作')
}

function operationElement(entry) {
  return String(entry.element_id || '未知元素')
}

function displayValue(entry) {
  if (entry.field === '#tombstone') return '已删除'
  const raw = entry.value_json
  if (raw == null || raw === 'null') return '空值'
  try {
    const parsed = JSON.parse(raw)
    if (String(entry.clock || '').startsWith('STATE|') && parsed && typeof parsed === 'object') {
      if (parsed['#tombstone'] === true) return '已删除'
      return String(parsed.text || parsed.name || parsed.title || parsed.coverName || '元素状态更新').slice(
        0,
        80,
      )
    }
    const text = typeof parsed === 'string' ? parsed : JSON.stringify(parsed)
    return text.length > 42 ? `${text.slice(0, 42)}...` : text
  } catch {
    return String(raw).slice(0, 42)
  }
}

function formatTime(raw) {
  if (!raw) return ''
  const date = new Date(raw)
  return Number.isNaN(date.getTime())
    ? String(raw)
    : new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }).format(date)
}

async function restore() {
  if (!canRestoreLoadedRevision.value) return
  restoreFailure.value = ''
  restoreTargetRev.value = loadedRev.value
  confirmRestore.value = true
}

function cancelRestore() {
  if (restoring.value) return
  confirmRestore.value = false
  restoreTargetRev.value = null
}

async function performRestore() {
  const revision = restoreTargetRev.value
  if (revision == null || revision !== loadedRev.value || !canRestoreLoadedRevision.value) {
    confirmRestore.value = false
    notify('预览版本已变化，请重新确认', 'error')
    return
  }
  confirmRestore.value = false
  restoring.value = true
  try {
    await api(`/api/docs/${encodeURIComponent(props.docKey)}/restore`, {
      method: 'POST',
      body: { rev: revision },
    })
    notify(`已恢复到 rev ${revision}`, 'success')
    emit('restored')
    emit('close')
  } catch (requestError) {
    restoreFailure.value = requestError.message
  } finally {
    restoring.value = false
    restoreTargetRev.value = null
  }
}

watch(() => props.docKey, loadHistory, { immediate: true })
</script>

<template>
  <BaseModal
    title="版本历史"
    description="选择历史记录，查看当时的内容"
    :close-disabled="restoring"
    wide
    @close="close"
  >
    <div v-if="loading" class="panel-state"><Clock3 class="spin" :size="20" /> 正在读取操作日志</div>
    <div v-else-if="failure" class="error-state history-load-error" role="alert">
      <p>{{ failure }}</p>
      <button class="button secondary" type="button" @click="loadHistory">
        <RotateCw :size="14" />重试历史记录
      </button>
    </div>
    <div v-else class="history-layout">
      <aside class="history-timeline" aria-label="版本时间线">
        <div v-if="hasNewerRevision" class="history-update-notice" role="status">
          <span>内容有新修改</span
          ><button type="button" :disabled="restoring" @click="loadHistory">刷新历史</button>
        </div>
        <form class="history-jump" @submit.prevent="jumpToRevision">
          <label for="history-revision">定位版本</label>
          <div>
            <input
              id="history-revision"
              v-model="revisionInput"
              type="number"
              min="0"
              :max="currentRev"
              step="1"
              inputmode="numeric"
              :disabled="restoring"
            />
            <button class="button secondary" type="submit" :disabled="restoring">查看</button>
          </div>
        </form>
        <button
          class="history-current"
          :class="{ active: selectedRev === currentRev }"
          type="button"
          :disabled="restoring"
          @click="selectRevision(currentRev)"
        >
          <span>当前版本</span><strong>rev {{ currentRev }}</strong>
        </button>
        <button
          v-for="entry in timeline"
          :key="entry.seq"
          class="history-entry"
          :class="{ active: selectedRev === Number(entry.seq) }"
          type="button"
          :disabled="restoring"
          @click="selectRevision(entry.seq)"
        >
          <span class="history-entry-top"
            ><strong>rev {{ entry.seq }}</strong
            ><time>{{ formatTime(entry.created_at) }}</time></span
          >
          <span>{{ operationType(entry) }} {{ operationSubject(entry) }}</span>
          <span class="history-entry-meta"
            ><span :title="operationActor(entry)">{{ operationActor(entry) }}</span
            ><code :title="operationElement(entry)">{{ operationElement(entry) }}</code></span
          >
          <small>{{ displayValue(entry) }}</small>
        </button>
        <p v-if="!timeline.length" class="empty-inline">还没有编辑日志</p>
        <p v-else-if="currentRev > timeline.length" class="history-range-note">
          显示最近 {{ timeline.length }} 条记录，更早版本可输入版本号查看。
        </p>
      </aside>

      <section class="history-preview" aria-live="polite">
        <div class="history-preview-head">
          <div>
            <Eye :size="17" /><strong
              >rev {{ previewLoading ? selectedRev : (loadedRev ?? selectedRev) }} 预览</strong
            >
          </div>
          <span v-if="loadedRev === currentRev && !previewLoading" class="status-pill">当前</span>
        </div>
        <div v-if="previewLoading" class="panel-state">正在生成版本快照</div>
        <div v-else-if="previewFailure" class="error-state history-load-error" role="alert">
          <p>{{ previewFailure }}</p>
          <button class="button secondary" type="button" @click="selectRevision(selectedRev)">
            <RotateCw :size="14" />重试版本预览
          </button>
        </div>
        <template v-else-if="kind === 'doc'">
          <div v-if="documentParagraphs.length" class="replay-document">
            <div v-for="paragraph in documentParagraphs" :key="paragraph.id">
              <AssetImage
                v-if="paragraph.type === 'IMAGE'"
                style="max-width: 100%; max-height: 350px"
                :asset-id="historyValue(paragraph, 'assetId', '')"
                :alt="historyValue(paragraph, 'name', '历史图片')"
              />
              <p v-else>{{ historyValue(paragraph, 'text', '') || '（空段落）' }}</p>
            </div>
          </div>
          <div v-else class="preview-empty">此版本没有段落</div>
        </template>
        <template v-else-if="kind === 'board'">
          <div v-if="boardCards.length" class="replay-board">
            <div class="replay-board-canvas">
              <div
                v-for="card in boardCards"
                :key="card.id"
                class="replay-note"
                :style="boardReplayStyle(card)"
              >
                <AssetImage
                  v-if="card.type === 'IMAGE'"
                  style="width: 100%; height: 100%; object-fit: contain"
                  :asset-id="historyValue(card, 'assetId', '')"
                  :alt="historyValue(card, 'name', '历史图片')"
                />
                <template v-else>{{ historyValue(card, 'text', '') || '空白卡片' }}</template>
              </div>
            </div>
          </div>
          <div v-else class="preview-empty">此版本没有白板卡片</div>
        </template>
        <template v-else>
          <div v-if="kanbanColumns.length" class="replay-kanban">
            <section v-for="column in kanbanColumns" :key="column.id">
              <h4>{{ historyValue(column, 'title', '未命名列表') }}</h4>
              <p
                v-for="card in cardsForHistoryColumn(boardCards, column.id)"
                :key="card.id"
                :style="{ background: historyValue(card, 'color', '#ffffff') }"
              >
                <AssetImage
                  v-if="historyValue(card, 'coverId', '')"
                  class="kanban-cover"
                  :asset-id="historyValue(card, 'coverId', '')"
                  :alt="historyValue(card, 'coverName', '历史封面')"
                />{{ historyValue(card, 'text', '') || '空白卡片' }}
              </p>
            </section>
          </div>
          <div v-else class="preview-empty">此版本没有看板列表</div>
        </template>
      </section>
    </div>

    <p v-if="restoreFailure" class="form-error history-restore-error" role="alert">{{ restoreFailure }}</p>

    <template #footer>
      <span v-if="!canRestore" class="readonly-note">当前仅可预览历史，无法恢复版本</span>
      <span v-else class="footer-spacer" />
      <button class="button secondary" type="button" :disabled="restoring" @click="close">关闭</button>
      <button class="button primary" type="button" :disabled="!canRestoreLoadedRevision" @click="restore">
        <RotateCcw :size="17" />{{ restoring ? '正在恢复' : '恢复到此版本' }}
      </button>
    </template>
  </BaseModal>
  <ConfirmDialog
    v-if="confirmRestore"
    title="恢复历史版本"
    :description="`确定将当前内容恢复到 rev ${restoreTargetRev}？恢复动作会作为新操作写入日志，可继续在历史中追溯。`"
    confirm-label="确认恢复"
    :busy="restoring"
    @cancel="cancelRestore"
    @confirm="performRestore"
  />
</template>

<style scoped>
.history-load-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 130px;
}
.history-load-error p {
  margin: 0;
}
.history-restore-error { margin: 14px 0 0; }
.history-update-notice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px;
  margin-bottom: 10px;
  border-radius: 5px;
  background: #eef2ff;
  color: #5369b4;
  font-size: 11px;
}
.history-update-notice button {
  padding: 0;
  border: 0;
  color: #4263eb;
  background: transparent;
  cursor: pointer;
  font-size: inherit;
  text-decoration: underline;
}
.history-range-note {
  margin: 10px 4px 0;
  color: #8a93a3;
  font-size: 11px;
  line-height: 1.7;
}
</style>
