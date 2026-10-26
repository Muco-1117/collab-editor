<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  ArrowUpRight,
  Check,
  FileText,
  LayoutDashboard,
  LoaderCircle,
  LockKeyhole,
  PanelTop,
  RotateCw,
  Search,
  Trash2,
  Undo2,
} from 'lucide-vue-next'
import { api } from '../lib/apiClient.js'

const props = defineProps({
  spaceId: { type: [String, Number], required: true },
  canManage: { type: Boolean, default: false },
})
const emit = defineEmits(['restored', 'open'])
const documents = ref([])
const loading = ref(false)
const error = ref('')
const query = ref('')
const restoringKey = ref('')
const restoreError = ref(null)
const restored = ref(null)
const types = {
  doc: { name: '文档', icon: FileText },
  board: { name: '白板', icon: PanelTop },
  kanban: { name: '看板', icon: LayoutDashboard },
}
const filtered = computed(() =>
  documents.value.filter((document) =>
    (document.title || '').toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase()),
  ),
)
let disposed = false
let generation = 0
let restoreGeneration = 0
let controller = null
let restoreController = null

function keyOf(document) {
  return document.doc_key || document.docKey
}
function deletedDate(document) {
  const value = document.deleted_at || document.deletedAt
  const date = new Date(value)
  return value && !Number.isNaN(date.getTime())
    ? new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(date)
    : '时间未知'
}

async function load() {
  const request = ++generation
  controller?.abort()
  error.value = ''
  if (!props.canManage) {
    documents.value = []
    loading.value = false
    return
  }
  controller = new AbortController()
  loading.value = true
  try {
    const result = await api(`/api/spaces/${encodeURIComponent(props.spaceId)}/trash`, {
      signal: controller.signal,
    })
    if (disposed || request !== generation) return
    if (!Array.isArray(result?.documents)) throw new Error('回收站数据不完整，请重新加载')
    documents.value = result.documents
  } catch (requestError) {
    if (!disposed && request === generation) {
      error.value = requestError.message
      if ([403, 404].includes(requestError.status)) documents.value = []
    }
  } finally {
    if (!disposed && request === generation) loading.value = false
  }
}

async function restore(document) {
  if (!props.canManage || restoringKey.value) return
  const key = keyOf(document)
  const spaceId = String(props.spaceId)
  const request = ++restoreGeneration
  restoringKey.value = key
  restoreError.value = null
  restoreController = new AbortController()
  try {
    const result = await api(`/api/docs/${encodeURIComponent(key)}/restore-deleted`, {
      method: 'POST',
      signal: restoreController.signal,
    })
    if (disposed || request !== restoreGeneration || String(props.spaceId) !== spaceId || !props.canManage)
      return
    // Prevent an in-flight list requested before restore from reintroducing the row.
    generation++
    controller?.abort()
    loading.value = false
    documents.value = documents.value.filter((item) => keyOf(item) !== key)
    restored.value = { ...document, ...result, doc_key: key, space_id: props.spaceId }
    emit('restored', restored.value)
  } catch (requestError) {
    if (!disposed && request === restoreGeneration && String(props.spaceId) === spaceId)
      restoreError.value = { key, message: requestError.message }
  } finally {
    if (!disposed && request === restoreGeneration && String(props.spaceId) === spaceId)
      restoringKey.value = ''
  }
}

watch(
  () => [props.spaceId, props.canManage],
  () => {
    restoreGeneration++
    restoreController?.abort()
    documents.value = []
    restoringKey.value = ''
    restored.value = null
    restoreError.value = null
    query.value = ''
    load()
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  disposed = true
  generation++
  restoreGeneration++
  controller?.abort()
  restoreController?.abort()
})
</script>

<template>
  <section class="trash-panel" aria-label="回收站">
    <div v-if="!canManage" class="trash-state">
      <LockKeyhole :size="28" />
      <h2>仅空间所有者可管理回收站</h2>
      <p>需要恢复内容时，请联系当前空间的所有者。</p>
    </div>
    <template v-else>
      <div class="trash-toolbar">
        <h2>
          已删除的内容 <span>{{ loading ? '—' : documents.length }}</span>
        </h2>
        <label class="library-search"
          ><Search :size="15" /><input
            v-model="query"
            type="search"
            aria-label="查找已删除的内容"
            placeholder="查找已删除的内容…"
        /></label>
        <button
          class="icon-button"
          type="button"
          aria-label="刷新回收站"
          title="刷新回收站"
          :disabled="loading || !!restoringKey"
          @click="load"
        >
          <RotateCw :size="16" :class="{ spin: loading }" />
        </button>
      </div>
      <p class="trash-description">恢复后，内容会回到原来的栏目，正文、图片和历史版本都会保留。</p>
      <div v-if="restored" class="trash-restored" role="status">
        <Check :size="17" /><span>已恢复“{{ restored.title || '未命名内容' }}”</span>
        <button type="button" @click="$emit('open', restored)">打开内容<ArrowUpRight :size="14" /></button>
      </div>
      <div v-if="error" class="dashboard-request-error" role="alert">
        <div>
          <strong>暂时无法加载回收站</strong>
          <p>{{ error }}</p>
        </div>
        <button class="button secondary" type="button" @click="load">
          <RotateCw :size="15" />重新加载回收站
        </button>
      </div>
      <div v-else-if="loading && !documents.length" class="trash-state" role="status">
        <LoaderCircle class="spin" :size="22" />
        <p>正在加载回收站</p>
      </div>
      <div v-else-if="!filtered.length" class="trash-state">
        <component :is="query.trim() ? Search : Trash2" :size="28" :stroke-width="1.5" />
        <h2>{{ query.trim() ? '没有找到匹配的内容' : '回收站是空的' }}</h2>
        <p>
          {{ query.trim() ? '换个名称试试，或清除查找。' : '空间中删除的文档、白板和看板会出现在这里。' }}
        </p>
        <button v-if="query.trim()" class="button secondary" type="button" @click="query = ''">
          清除查找
        </button>
      </div>
      <div v-else class="trash-list">
        <article
          v-for="document in filtered"
          :key="keyOf(document)"
          class="trash-row"
          :data-trash-key="keyOf(document)"
        >
          <span class="trash-kind-icon" :class="`kind-${document.kind || 'doc'}`"
            ><component :is="types[document.kind || 'doc'].icon" :size="19"
          /></span>
          <div class="trash-content">
            <strong>{{ document.title || '未命名内容' }}</strong
            ><span
              >{{ types[document.kind || 'doc'].name }}<span class="trash-separator">/</span
              >{{ deletedDate(document) }} 删除</span
            >
          </div>
          <button
            class="button secondary"
            type="button"
            :disabled="!!restoringKey"
            :aria-label="`恢复${document.title || '未命名内容'}`"
            @click="restore(document)"
          >
            <LoaderCircle v-if="restoringKey === keyOf(document)" class="spin" :size="15" /><Undo2
              v-else
              :size="15"
            />{{ restoringKey === keyOf(document) ? '正在恢复' : '恢复' }}
          </button>
          <p v-if="restoreError?.key === keyOf(document)" class="trash-restore-error" role="alert">
            {{ restoreError.message }}，可以再次点击恢复重试。
          </p>
        </article>
      </div>
    </template>
  </section>
</template>

<style scoped>
.trash-panel {
  min-width: 0;
}
.trash-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding-bottom: 18px;
  border-bottom: 1px solid #e9ebef;
}
.trash-toolbar h2 {
  margin: 0 auto 0 0;
  color: #424b5a;
  font-size: 14px;
  font-weight: 600;
}
.trash-toolbar h2 > span {
  margin-left: 8px;
  color: #929aaa;
  font-size: 12px;
  font-weight: 400;
}
.trash-description {
  margin: 15px 0 22px;
  color: #838d9d;
  font-size: 12px;
  line-height: 1.8;
}
.trash-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 320px;
  gap: 12px;
  color: #a0a8b5;
  text-align: center;
}
.trash-state h2 {
  margin: 3px 0 0;
  color: #5f6979;
  font-size: 16px;
  font-weight: 550;
}
.trash-state p {
  margin: 0;
  color: #9099a6;
  font-size: 12px;
  line-height: 1.8;
}
.trash-restored {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
  padding: 13px 15px;
  border: 1px solid #dce9e3;
  border-radius: 7px;
  background: #f6faf8;
  color: #537565;
  font-size: 12px;
}
.trash-restored > svg {
  flex-shrink: 0;
}
.trash-restored > span {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.trash-restored button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  padding: 5px 0;
  border: 0;
  background: transparent;
  color: #537565;
  font-size: 12px;
  cursor: pointer;
}
.trash-row {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  min-height: 87px;
  padding: 16px 8px;
  border-bottom: 1px solid #edf0f4;
}
.trash-kind-icon {
  display: grid;
  place-items: center;
  width: 36px;
  height: 40px;
  background: #f0f4ff;
  color: #718bc7;
  border-radius: 5px;
}
.trash-kind-icon.kind-board {
  color: #b08a3e;
  background: #fbf5e7;
}
.trash-kind-icon.kind-kanban {
  color: #967acb;
  background: #f4effc;
}
.trash-content {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 6px;
}
.trash-content > strong {
  overflow: hidden;
  color: #414b5e;
  font-size: 13px;
  font-weight: 550;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.trash-content > span {
  color: #949caa;
  font-size: 11px;
  line-height: 1.6;
}
.trash-separator {
  padding: 0 7px;
  color: #bcc3ce;
}
.trash-restore-error {
  grid-column: 2 / -1;
  margin: 0;
  color: #a36b53;
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
@media (max-width: 600px) {
  .trash-toolbar h2 {
    flex: 1 1 100%;
  }
  .trash-toolbar .library-search {
    flex: 1;
    width: auto;
  }
  .trash-row {
    padding: 15px 0;
    gap: 9px;
    grid-template-columns: 30px minmax(0, 1fr) auto;
  }
  .trash-kind-icon {
    width: 30px;
    height: 36px;
  }
  .trash-content > strong {
    font-size: 12px;
  }
  .trash-content > span {
    font-size: 10px;
  }
  .trash-state {
    min-height: 270px;
  }
  .trash-restored {
    flex-wrap: wrap;
  }
}
</style>
