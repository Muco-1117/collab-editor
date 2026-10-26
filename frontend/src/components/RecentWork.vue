<script setup>
import { ArrowUpRight, Clock3, FileText, LayoutDashboard, PanelTop } from 'lucide-vue-next'

defineProps({ documents: { type: Array, default: () => [] } })
defineEmits(['open'])
const kinds = {
  doc: { icon: FileText, name: '文档' },
  board: { icon: PanelTop, name: '白板' },
  kanban: { icon: LayoutDashboard, name: '看板' },
}

function openedLabel(value) {
  const age = Math.max(0, Date.now() - value)
  if (age < 60_000) return '刚刚打开'
  if (age < 3_600_000) return `${Math.floor(age / 60_000)} 分钟前打开`
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)} 小时前打开`
  return `${new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(value)}打开`
}
</script>

<template>
  <section v-if="documents.length" class="recent-work" aria-labelledby="recent-work-heading">
    <div class="recent-work-heading">
      <h2 id="recent-work-heading">继续工作</h2>
      <span><Clock3 :size="13" />最近打开</span>
    </div>
    <div class="recent-work-list">
      <button
        v-for="document in documents"
        :key="document.doc_key || document.docKey"
        class="recent-work-item"
        type="button"
        :aria-label="`继续${kinds[document.kind || 'doc'].name}：${document.title || '未命名内容'}`"
        @click="$emit('open', document)"
      >
        <span class="recent-work-icon" :class="`kind-${document.kind || 'doc'}`">
          <component :is="kinds[document.kind || 'doc'].icon" :size="18" />
        </span>
        <span class="recent-work-copy">
          <strong>{{ document.title || '未命名内容' }}</strong>
          <span>{{ openedLabel(document.openedAt) }}</span>
        </span>
        <ArrowUpRight class="recent-work-arrow" :size="15" aria-hidden="true" />
      </button>
    </div>
  </section>
</template>

<style scoped>
.recent-work {
  margin-bottom: 32px;
}
.recent-work-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 15px;
}
.recent-work-heading h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: #343c4b;
}
.recent-work-heading > span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: #8d95a3;
}
.recent-work-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 18px;
}
.recent-work-item {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  min-height: 76px;
  padding: 14px 16px;
  border: 1px solid #e9ebef;
  border-radius: 7px;
  background: #fff;
  color: #343c4b;
  text-align: left;
  cursor: pointer;
}
.recent-work-item:hover {
  background: #fafbfe;
  border-color: #d7dfef;
}
.recent-work-item:focus-visible {
  outline: 2px solid #4263eb;
  outline-offset: 3px;
}
.recent-work-icon {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 33px;
  height: 38px;
  border-radius: 5px;
  background: #f0f4ff;
  color: #6b85d9;
}
.recent-work-icon.kind-board {
  background: #fbf5e7;
  color: #b08a3e;
}
.recent-work-icon.kind-kanban {
  background: #f4effc;
  color: #967acb;
}
.recent-work-copy {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 5px;
}
.recent-work-copy strong {
  overflow: hidden;
  font-size: 12px;
  font-weight: 550;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.recent-work-copy > span {
  font-size: 10px;
  color: #929aa8;
}
.recent-work-arrow {
  flex-shrink: 0;
  color: #a5adba;
}
@media (max-width: 600px) {
  .recent-work-list {
    grid-template-columns: 1fr;
    gap: 8px;
  }
  .recent-work-item {
    min-height: 68px;
    padding: 12px;
  }
  .recent-work-heading h2 {
    font-size: 14px;
  }
}
</style>
