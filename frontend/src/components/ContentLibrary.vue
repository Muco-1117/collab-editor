<script setup>
import { markRaw, onBeforeUnmount, onMounted, reactive, watch } from 'vue'
import { FileText, LayoutDashboard, LoaderCircle, LockKeyhole, PanelTop, RotateCw } from 'lucide-vue-next'
import AssetImage from './AssetImage.vue'
import DocumentActions from './DocumentActions.vue'
import { api } from '../lib/apiClient.js'
import { createBoardPreview, createDocumentPreview, createKanbanPreview } from '../lib/contentPreview.js'

const props = defineProps({
  kind: { type: String, required: true },
  documents: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  refreshVersion: { type: Number, default: 0 },
})
defineEmits(['open', 'renamed', 'deleted'])

const previews = reactive(new Map())
const targets = new Map()
const queue = []
let observer
let mounted = false
let disposed = false
let activeRequests = 0
const names = { doc: '文档', board: '白板', kanban: '看板' }
const icons = { doc: FileText, board: PanelTop, kanban: LayoutDashboard }
const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

function keyOf(document) {
  return String(document.doc_key || document.docKey || '')
}

function updatedOf(document) {
  return document.updated_at || document.updatedAt || document.created_at || document.createdAt || ''
}

function signatureOf(document) {
  return `${props.kind}:${keyOf(document)}:${updatedOf(document)}:${props.refreshVersion}`
}

function formatDate(document) {
  const value = updatedOf(document)
  if (!value) return '暂无更新时间'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : dateFormatter.format(date)
}

function isReadonly(document) {
  return !['owner', 'admin', 'editor'].includes(document.my_role || document.myRole)
}

function previewOf(document) {
  return previews.get(keyOf(document))
}

function isCurrent(entry) {
  return !disposed && !props.loading && props.kind === entry.kind && previews.get(entry.key) === entry
}

function enqueue(key) {
  const entry = previews.get(key)
  if (!entry || entry.status !== 'idle' || !isCurrent(entry)) return
  entry.status = 'queued'
  queue.push(entry)
  pump()
}

function pump() {
  while (!disposed && activeRequests < 3 && queue.length) {
    const entry = queue.shift()
    if (!isCurrent(entry) || entry.status !== 'queued') continue
    activeRequests++
    entry.status = 'loading'
    loadPreview(entry).finally(() => {
      activeRequests--
      pump()
    })
  }
}

async function loadPreview(entry) {
  const controller = markRaw(new AbortController())
  entry.controller = controller
  try {
    const path = `/api/docs/${encodeURIComponent(entry.key)}`
    const history = await api(`${path}/history?limit=1`, { signal: controller.signal })
    if (!isCurrent(entry)) return
    const revision = Number(history?.rev)
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('无法读取内容版本')
    const snapshot = await api(`${path}/replay?rev=${revision}`, { signal: controller.signal })
    if (!isCurrent(entry)) return
    if (Number(snapshot?.rev) !== revision || !Array.isArray(snapshot?.elements)) {
      throw new Error('预览数据不完整')
    }
    entry.data = markRaw(
      entry.kind === 'doc'
        ? createDocumentPreview(snapshot.elements)
        : entry.kind === 'board'
          ? createBoardPreview(snapshot.elements)
          : createKanbanPreview(snapshot.elements),
    )
    entry.status = 'ready'
  } catch {
    if (isCurrent(entry)) entry.status = 'error'
  } finally {
    entry.controller = null
  }
}

function retry(document) {
  const entry = previewOf(document)
  if (entry?.status !== 'error') return
  entry.status = 'idle'
  enqueue(entry.key)
}

function observeTarget(key, element) {
  const entry = previews.get(key)
  if (!mounted || !element || !entry || entry.status !== 'idle') return
  if (observer) observer.observe(element)
  else enqueue(key)
}

function setTarget(key, element) {
  const previous = targets.get(key)
  if (previous && previous !== element) observer?.unobserve(previous)
  if (!element) {
    targets.delete(key)
    return
  }
  targets.set(key, element)
  observeTarget(key, element)
}

function syncEntries() {
  const desired = new Map(props.documents.map((document) => [keyOf(document), signatureOf(document)]))
  for (const [key, entry] of previews) {
    if (props.loading || desired.get(key) !== entry.signature) {
      entry.controller?.abort()
      previews.delete(key)
    }
  }
  for (let index = queue.length - 1; index >= 0; index--) {
    if (!isCurrent(queue[index])) queue.splice(index, 1)
  }
  if (props.loading) return
  for (const [key, signature] of desired) {
    if (!key || previews.has(key)) continue
    previews.set(
      key,
      reactive({ key, signature, kind: props.kind, status: 'idle', data: null, controller: null }),
    )
  }
  for (const [key, element] of targets) observeTarget(key, element)
}

watch(() => [props.kind, props.loading, props.documents.map(signatureOf).join('\n')], syncEntries, {
  immediate: true,
  flush: 'post',
})

onMounted(() => {
  mounted = true
  if (typeof IntersectionObserver !== 'undefined') {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          observer.unobserve(entry.target)
          enqueue(entry.target.dataset.previewKey)
        }
      },
      { rootMargin: '120px 0px' },
    )
  }
  for (const [key, element] of targets) observeTarget(key, element)
})

onBeforeUnmount(() => {
  disposed = true
  observer?.disconnect()
  for (const entry of previews.values()) entry.controller?.abort()
  queue.length = 0
  targets.clear()
})
</script>

<template>
  <div class="content-library" :class="`library-${kind}`" :data-library-kind="kind">
    <div v-if="loading" class="library-state" role="status">
      <LoaderCircle class="spin" :size="20" />正在加载{{ names[kind] }}
    </div>
    <div v-else-if="!documents.length" class="library-state">这里还没有{{ names[kind] }}</div>

    <div v-else-if="kind === 'doc'" class="library-document-list">
      <div class="library-list-labels" aria-hidden="true"><span>文档名称</span><span>最后更新</span></div>
      <article
        v-for="document in documents"
        :key="keyOf(document)"
        :ref="(element) => setTarget(keyOf(document), element)"
        class="library-document-row"
        :data-preview-key="keyOf(document)"
        :data-preview-status="previewOf(document)?.status || 'idle'"
      >
        <button
          class="library-document-open"
          type="button"
          :aria-label="`打开文档：${document.title || '未命名文档'}`"
          @click="$emit('open', document)"
        >
          <span class="library-type-icon"><FileText :size="19" aria-hidden="true" /></span>
          <span class="library-document-title">
            <strong>{{ document.title || '未命名文档' }}</strong>
            <span class="library-document-excerpt" v-if="previewOf(document)?.status === 'ready'">
              {{
                previewOf(document).data.excerpt ||
                (previewOf(document).data.imageCount
                  ? '文档包含图片，打开查看完整内容'
                  : '还没有正文，打开继续书写')
              }}
            </span>
            <span v-else class="library-document-excerpt">
              {{ previewOf(document)?.status === 'error' ? '摘要暂时不可用，仍可打开文档' : '正在读取摘要…' }}
            </span>
            <span class="library-document-meta">
              <template v-if="previewOf(document)?.status === 'ready'">
                {{ previewOf(document).data.characterCount }} 字<span class="library-meta-dot">·</span>
                {{ previewOf(document).data.paragraphCount }} 段落
                <template v-if="previewOf(document).data.imageCount"
                  ><span class="library-meta-dot">·</span
                  >{{ previewOf(document).data.imageCount }} 张图片</template
                >
                <span class="library-meta-dot">·</span>
              </template>
              {{ isReadonly(document) ? '仅可查看' : '可协作编辑' }}
            </span>
          </span>
          <time class="library-list-date" :datetime="updatedOf(document)">{{ formatDate(document) }}</time>
        </button>
        <DocumentActions
          :document="document"
          @open="$emit('open', $event)"
          @renamed="$emit('renamed', $event)"
          @deleted="$emit('deleted', $event)"
        />
        <button
          v-if="previewOf(document)?.status === 'error'"
          class="library-document-retry"
          type="button"
          :aria-label="`重新加载“${document.title}”的摘要`"
          @click="retry(document)"
        >
          <RotateCw :size="12" />重试摘要
        </button>
      </article>
    </div>

    <div v-else class="library-gallery">
      <article
        v-for="document in documents"
        :key="keyOf(document)"
        :ref="(element) => setTarget(keyOf(document), element)"
        class="library-card"
        :data-preview-key="keyOf(document)"
        :data-preview-status="previewOf(document)?.status || 'idle'"
      >
        <div class="library-preview-wrap">
          <button
            class="library-preview-open"
            type="button"
            :aria-label="`打开${names[kind]}：${document.title || '未命名内容'}`"
            @click="$emit('open', document)"
          >
            <template v-if="previewOf(document)?.status === 'ready'">
              <template v-if="kind === 'board'">
                <svg
                  v-if="previewOf(document).data.count"
                  class="library-board-canvas"
                  :viewBox="previewOf(document).data.viewBox"
                  aria-hidden="true"
                >
                  <g v-for="item in previewOf(document).data.items" :key="item.id">
                    <rect
                      :x="item.x"
                      :y="item.y"
                      :width="item.width"
                      :height="item.height"
                      rx="5"
                      :fill="item.color"
                      stroke="rgba(47, 50, 57, 0.12)"
                      stroke-width="1"
                    />
                    <foreignObject :x="item.x" :y="item.y" :width="item.width" :height="item.height">
                      <div
                        xmlns="http://www.w3.org/1999/xhtml"
                        class="library-board-item"
                        :class="{ 'is-image': item.type === 'IMAGE' }"
                      >
                        <AssetImage
                          v-if="item.type === 'IMAGE' && item.assetId"
                          :asset-id="item.assetId"
                          :alt="item.name"
                          :retryable="false"
                        />
                        <span v-else-if="item.type === 'IMAGE'" class="asset-placeholder">图片未就绪</span>
                        <span v-else>{{ item.text || '空白卡片' }}</span>
                      </div>
                    </foreignObject>
                  </g>
                </svg>
                <span v-else class="library-preview-state"
                  ><PanelTop :size="25" /><span>还没有卡片或图片</span
                  ><small>打开白板，记录第一个想法</small></span
                >
              </template>
              <template v-else>
                <span
                  v-if="previewOf(document).data.columnCount"
                  class="library-kanban-preview"
                  :style="{ '--preview-columns': previewOf(document).data.columns.length }"
                  aria-hidden="true"
                >
                  <span
                    v-for="column in previewOf(document).data.columns"
                    :key="column.id"
                    class="library-mini-column"
                  >
                    <span class="library-mini-column-head"
                      ><strong>{{ column.title }}</strong
                      ><small>{{ column.count }}</small></span
                    >
                    <span v-if="!column.cards.length" class="library-empty-column">暂无任务</span>
                    <span
                      v-for="card in column.cards"
                      :key="card.id"
                      class="library-mini-task"
                      :style="{ backgroundColor: card.color }"
                    >
                      <AssetImage
                        v-if="card.coverId"
                        class="library-task-cover"
                        :asset-id="card.coverId"
                        :alt="card.coverName"
                        :retryable="false"
                      />
                      <span>{{ card.text || '空白任务' }}</span>
                    </span>
                    <span v-if="column.remaining" class="library-more-tasks"
                      >还有 {{ column.remaining }} 项任务</span
                    >
                  </span>
                </span>
                <span v-else class="library-preview-state"
                  ><LayoutDashboard :size="25" /><span>还没有任务列表</span
                  ><small>打开看板，开始安排工作</small></span
                >
              </template>
            </template>
            <span
              v-else-if="previewOf(document)?.status === 'error'"
              class="library-preview-state library-preview-error"
            >
              <component :is="icons[kind]" :size="25" /><span>预览暂时不可用</span
              ><small>仍可打开内容查看</small>
            </span>
            <span v-else class="library-preview-state"
              ><LoaderCircle class="spin" :size="19" /><span>正在读取预览</span></span
            >
          </button>
          <button
            v-if="previewOf(document)?.status === 'error'"
            class="library-preview-retry"
            type="button"
            :aria-label="`重新加载“${document.title}”的预览`"
            @click="retry(document)"
          >
            <RotateCw :size="13" />重试预览
          </button>
        </div>
        <div class="library-card-info">
          <div class="library-card-heading">
            <button class="library-card-title" type="button" @click="$emit('open', document)">
              <component :is="icons[kind]" :size="16" aria-hidden="true" /><strong>{{
                document.title || '未命名内容'
              }}</strong>
            </button>
            <DocumentActions
              :document="document"
              @open="$emit('open', $event)"
              @renamed="$emit('renamed', $event)"
              @deleted="$emit('deleted', $event)"
            />
          </div>
          <div class="library-preview-summary">
            <span v-if="previewOf(document)?.status === 'ready' && kind === 'board'"
              >{{ previewOf(document).data.count }} 个画布元素</span
            >
            <span v-else-if="previewOf(document)?.status === 'ready'"
              >{{ previewOf(document).data.columnCount }} 个列表<span class="library-meta-dot">·</span
              >{{ previewOf(document).data.cardCount }} 项任务<span
                v-if="previewOf(document).data.remaining"
                class="library-preview-limit"
                >（预览前 3 列）</span
              ></span
            >
            <span v-else>{{ names[kind] }}</span>
            <span v-if="isReadonly(document)" class="library-readonly"><LockKeyhole :size="11" />只读</span>
          </div>
          <div
            v-if="
              kind === 'kanban' &&
              previewOf(document)?.status === 'ready' &&
              previewOf(document).data.cardCount
            "
            class="library-task-distribution"
          >
            <div
              class="library-distribution-bar"
              role="img"
              :aria-label="`任务分布：${previewOf(document)
                .data.distribution.map((column) => `${column.title} ${column.count} 项`)
                .join('，')}`"
            >
              <span
                v-for="(column, index) in previewOf(document).data.distribution.filter((item) => item.count)"
                :key="column.id"
                :style="{
                  flex: column.count,
                  backgroundColor: ['#a4b9f2', '#b8a6df', '#8dc7b2', '#e0bc83', '#b2bfce'][index % 5],
                }"
              />
            </div>
            <span class="library-distribution-label">{{
              previewOf(document)
                .data.distribution.map((column) => `${column.title} ${column.count}`)
                .join(' / ')
            }}</span>
          </div>
          <time class="library-card-date" :datetime="updatedOf(document)"
            >{{ formatDate(document) }}{{ updatedOf(document) ? ' 更新' : '' }}</time
          >
        </div>
      </article>
    </div>
  </div>
</template>

<style scoped>
.content-library {
  min-width: 0;
  color: #303746;
}
.library-state {
  min-height: 180px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  color: #858d9b;
  font-size: 13px;
}
.library-document-list {
  border-top: 1px solid #eceef2;
}
.library-list-labels {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 176px;
  padding: 13px 46px 13px 10px;
  color: #969ca7;
  font-size: 11px;
}
.library-document-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 34px;
  align-items: center;
  padding: 0 6px 0 0;
  border-top: 1px solid #eff0f3;
  border-radius: 5px;
  transition: background 140ms ease;
}
.library-document-row:hover {
  background: #f8f9fc;
}
.library-document-open {
  display: flex;
  align-items: center;
  gap: 13px;
  min-width: 0;
  min-height: 104px;
  padding: 16px 10px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.library-type-icon {
  display: grid;
  place-items: center;
  width: 36px;
  height: 42px;
  flex-shrink: 0;
  border: 1px solid #e9edf8;
  border-radius: 5px;
  color: #6782cd;
  background: #f4f7fd;
}
.library-document-title {
  min-width: 0;
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 6px;
}
.library-document-title > strong {
  overflow: hidden;
  color: #384052;
  font-size: 13px;
  font-weight: 550;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.library-document-title > span {
  overflow: hidden;
  color: #939aa7;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.library-document-title > .library-document-excerpt {
  color: #778292;
  line-height: 1.6;
}
.library-document-title > .library-document-meta {
  font-size: 10px;
  line-height: 1.5;
}
.library-document-retry {
  grid-column: 1;
  justify-self: start;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin: -7px 0 12px 59px;
  padding: 4px 6px;
  border: 1px solid #e3e8f1;
  border-radius: 4px;
  background: #fff;
  color: #6478ac;
  font-size: 10px;
  cursor: pointer;
}
.library-task-distribution {
  margin-top: 13px;
}
.library-distribution-bar {
  display: flex;
  gap: 3px;
  height: 5px;
  overflow: hidden;
  border-radius: 3px;
}
.library-distribution-bar > span {
  min-width: 2px;
}
.library-distribution-label {
  display: block;
  margin-top: 7px;
  overflow: hidden;
  color: #8e97a5;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.library-list-date {
  flex: 0 0 176px;
  color: #8b93a1;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.library-meta-dot {
  padding: 0 6px;
  color: #b5bac4;
}
.library-gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 290px), 1fr));
  align-items: start;
  gap: 20px;
}
.library-kanban .library-gallery {
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 370px), 1fr));
}
.library-card {
  min-width: 0;
  overflow: hidden;
  border: 1px solid #e8ebf0;
  border-radius: 10px;
  background: #fff;
  transition:
    border-color 140ms ease,
    box-shadow 140ms ease;
}
.library-card:hover {
  border-color: #d7dce6;
  box-shadow: 0 3px 12px #252a3408;
}
.library-preview-wrap {
  position: relative;
  min-width: 0;
}
.library-preview-open {
  display: block;
  width: 100%;
  height: 204px;
  overflow: hidden;
  padding: 0;
  border: 0;
  border-bottom: 1px solid #eceef2;
  border-radius: 9px 9px 0 0;
  background-color: #fafbfc;
  text-align: left;
  cursor: pointer;
}
.library-board .library-preview-open {
  background-color: #fafaf8;
  background-image: radial-gradient(#dadcd9 0.7px, transparent 0.7px);
  background-size: 15px 15px;
}
.library-board-canvas {
  display: block;
  width: 100%;
  height: 100%;
  padding: 13px;
}
.library-board-item {
  width: 100%;
  height: 100%;
  overflow: hidden;
  padding: 17px 15px;
  color: #414443;
  font-family: 'Segoe UI', 'Microsoft YaHei UI', sans-serif;
  font-size: 17px;
  line-height: 1.65;
  text-align: left;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.library-board-item.is-image {
  padding: 3px;
}
.library-board-item :deep(img) {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.library-board-item :deep(.asset-placeholder) {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  padding: 8px;
}
.library-kanban .library-preview-open {
  height: 232px;
  background: #f7f8fb;
}
.library-kanban-preview {
  display: grid;
  grid-template-columns: repeat(var(--preview-columns), minmax(0, 1fr));
  align-items: start;
  gap: 8px;
  height: 100%;
  padding: 17px 12px;
}
.library-mini-column {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 7px;
}
.library-mini-column-head {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  min-height: 20px;
  margin-bottom: 3px;
  color: #6c7084;
}
.library-mini-column-head::before {
  content: '';
  width: 5px;
  height: 5px;
  flex-shrink: 0;
  border-radius: 50%;
  background: #b8b1cf;
}
.library-mini-column-head strong {
  min-width: 0;
  overflow: hidden;
  font-size: 10px;
  font-weight: 550;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.library-mini-column-head small {
  flex-shrink: 0;
  margin-left: auto;
  color: #9a9eae;
  font-size: 9px;
}
.library-mini-task {
  display: block;
  min-width: 0;
  overflow: hidden;
  padding: 8px 7px;
  border: 1px solid #e8e9ef;
  border-radius: 4px;
  color: #636777;
  box-shadow: 0 1px 2px #30374603;
}
.library-mini-task > span {
  display: -webkit-box;
  overflow: hidden;
  font-size: 10px;
  line-height: 1.55;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.library-mini-task :deep(.library-task-cover) {
  width: 100%;
  max-height: 33px;
  margin-bottom: 5px;
  object-fit: cover;
  border-radius: 2px;
}
.library-mini-task :deep(.asset-placeholder) {
  padding: 0;
  font-size: 9px;
}
.library-empty-column,
.library-more-tasks {
  padding: 4px 2px;
  color: #a4a8b5;
  font-size: 9px;
}
.library-preview-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  flex-direction: column;
  width: 100%;
  height: 100%;
  padding: 22px;
  color: #a4abba;
  font-size: 12px;
  text-align: center;
}
.library-preview-state small {
  margin-top: -4px;
  color: #a3a9b3;
  font-size: 10px;
}
.library-preview-error {
  padding-bottom: 48px;
}
.library-preview-retry {
  position: absolute;
  bottom: 20px;
  left: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-height: 28px;
  padding: 4px 9px;
  border: 1px solid #e1e5ed;
  border-radius: 5px;
  color: #6f7f9f;
  background: #fff;
  font-size: 11px;
  white-space: nowrap;
  transform: translateX(-50%);
  cursor: pointer;
}
.library-preview-retry:hover {
  color: #4263eb;
  border-color: #c9d3f8;
}
.library-card-info {
  padding: 12px 15px 15px;
}
.library-card-heading {
  display: flex;
  align-items: center;
  gap: 7px;
}
.library-card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  min-height: 32px;
  padding: 0;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.library-card-title > svg {
  flex-shrink: 0;
  color: #bc984c;
}
.library-kanban .library-card-title > svg {
  color: #9483bf;
}
.library-card-title > strong {
  min-width: 0;
  overflow: hidden;
  color: #3c4352;
  font-size: 13px;
  font-weight: 550;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.library-preview-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 5px 10px;
  margin-top: 5px;
  color: #969dab;
  font-size: 10px;
}
.library-preview-limit {
  color: #a4aab6;
}
.library-readonly {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.library-card-date {
  display: block;
  margin-top: 10px;
  color: #a0a6b1;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
@media (max-width: 600px) {
  .library-list-labels {
    display: none;
  }
  .library-document-open {
    display: grid;
    grid-template-columns: 30px minmax(0, 1fr);
    gap: 5px 10px;
    padding: 13px 7px;
  }
  .library-type-icon {
    grid-row: span 2;
    width: 30px;
    height: 37px;
  }
  .library-document-title {
    gap: 4px;
  }
  .library-document-title > strong {
    font-size: 12px;
  }
  .library-document-title > span {
    font-size: 10px;
  }
  .library-list-date {
    grid-column: 2;
    margin-top: 1px;
    font-size: 10px;
  }
  .library-gallery {
    gap: 15px;
  }
  .library-card-info {
    padding: 10px 12px 13px;
  }
  .library-card-date {
    font-size: 10px;
  }
  .library-kanban-preview {
    gap: 6px;
    padding: 14px 9px;
  }
  .library-mini-task {
    padding: 7px 5px;
  }
  .library-card-heading :deep(.action-menu-trigger),
  .library-document-row :deep(.action-menu-trigger) {
    width: 34px;
    min-height: 38px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .library-card,
  .library-document-row {
    transition: none;
  }
}
</style>
