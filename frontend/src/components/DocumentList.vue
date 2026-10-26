<script setup>
import { FileText, LayoutDashboard, LoaderCircle, PanelTop, Trash2 } from 'lucide-vue-next'
import DocumentActions from './DocumentActions.vue'

defineProps({
  documents: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  compact: { type: Boolean, default: false },
  emptyText: { type: String, default: '这里还没有内容' },
  activeKey: { type: String, default: '' },
  allowDelete: { type: Boolean, default: true },
  actions: { type: Boolean, default: false },
  layout: { type: String, default: 'list' },
  showSpace: { type: Boolean, default: true },
})
defineEmits(['open', 'delete', 'renamed', 'deleted'])

const icons = { doc: FileText, board: PanelTop, kanban: LayoutDashboard }
const names = { doc: '文档', board: '白板', kanban: '看板' }

function keyOf(document) {
  return document.doc_key || document.docKey
}

function dateOf(document) {
  const raw = document.updated_at || document.updatedAt || document.created_at
  if (!raw) return ''
  const date = new Date(raw)
  return Number.isNaN(date.getTime())
    ? String(raw)
    : new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(date)
}
</script>

<template>
  <div class="document-list" :class="{ compact, 'document-grid': !compact && layout === 'grid' }">
    <div v-if="loading" class="list-state" role="status">
      <LoaderCircle class="spin" :size="20" /> 正在加载
    </div>
    <div v-else-if="!documents.length" class="list-state">{{ emptyText }}</div>
    <article
      v-for="document in documents"
      v-else
      :key="keyOf(document)"
      class="document-row"
      :class="{ active: activeKey === keyOf(document) }"
      tabindex="0"
      role="button"
      @click="$emit('open', document)"
      @keydown.enter.self="$emit('open', document)"
      @keydown.space.self.prevent="$emit('open', document)"
    >
      <span class="document-icon" :class="`kind-${document.kind || 'doc'}`">
        <component :is="icons[document.kind] || FileText" :size="19" />
      </span>
      <span class="document-main">
        <strong>{{ document.title || '未命名内容' }}</strong>
        <small
          >{{ names[document.kind] || '文档'
          }}<template v-if="showSpace && document.space_name"> · {{ document.space_name }}</template></small
        >
      </span>
      <time v-if="!compact" class="document-date">{{ dateOf(document) }}</time>
      <DocumentActions
        v-if="compact || actions"
        :document="document"
        :allow-delete="allowDelete"
        @open="$emit('open', $event)"
        @renamed="$emit('renamed', $event)"
        @deleted="$emit('deleted', $event)"
      />
      <button
        v-else-if="allowDelete && ['owner', 'admin'].includes(document.my_role || document.myRole)"
        class="icon-button danger-on-hover"
        type="button"
        :aria-label="`删除${document.title}`"
        title="删除"
        @click.stop="$emit('delete', document)"
      >
        <Trash2 :size="17" />
      </button>
    </article>
  </div>
</template>
