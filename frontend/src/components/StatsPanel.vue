<script setup>
import { Activity, Boxes, FileStack, FolderKanban } from 'lucide-vue-next'
import { computed } from 'vue'

const props = defineProps({
  stats: { type: Object, default: null },
  loading: { type: Boolean, default: false },
})

const applicationNames = { doc: '协同文档', board: '协同白板', kanban: '协同看板' }
const operationNames = { ADD: '创建元素', PUT: '更新字段', STATE: '更新元素状态', DELETE: '删除元素' }
const maxApplication = computed(() =>
  Math.max(1, ...(props.stats?.byApplication || []).map((row) => Number(row.operation_count) || 0)),
)
const maxOperation = computed(() =>
  Math.max(1, ...(props.stats?.byOperation || []).map((row) => Number(row.operation_count) || 0)),
)
const maxRecent = computed(() =>
  Math.max(1, ...(props.stats?.recentActivity || []).map((row) => Number(row.operation_count) || 0)),
)

function percent(value, maximum) {
  const count = Number(value) || 0
  return `${count <= 0 ? 0 : Math.min(100, Math.max(1, Math.round((count / maximum) * 100)))}%`
}
</script>

<template>
  <section class="stats-section" aria-labelledby="stats-heading">
    <div class="section-heading">
      <div>
        <h2 id="stats-heading">协作概览</h2>
      </div>
      <Activity :size="20" aria-hidden="true" />
    </div>

    <div v-if="loading" class="panel-state" role="status">正在加载协作数据</div>
    <template v-else-if="stats">
      <div class="metric-grid" :class="{ 'metric-grid-four': stats.ownOperations != null }">
        <div class="metric">
          <FolderKanban :size="18" /><span>空间</span><strong>{{ stats.spaces ?? 0 }}</strong>
        </div>
        <div class="metric">
          <FileStack :size="18" /><span>内容</span><strong>{{ stats.documents ?? 0 }}</strong>
        </div>
        <div class="metric">
          <Boxes :size="18" /><span>协作操作</span><strong>{{ stats.operations ?? 0 }}</strong>
        </div>
        <div v-if="stats.ownOperations != null" class="metric">
          <Activity :size="18" /><span>我的操作</span><strong>{{ stats.ownOperations }}</strong>
        </div>
      </div>

      <div class="stats-columns">
        <div class="bar-group">
          <h3>内容类型</h3>
          <p v-if="!stats.byApplication?.length" class="empty-inline">暂无操作数据</p>
          <div v-for="row in stats.byApplication || []" :key="row.kind" class="bar-row">
            <div>
              <span>{{ applicationNames[row.kind] || row.kind }}</span
              ><strong>{{ row.operation_count }}</strong>
            </div>
            <span class="bar-track"
              ><i :style="{ width: percent(row.operation_count, maxApplication) }"
            /></span>
          </div>
        </div>
        <div class="bar-group">
          <h3>编辑活动</h3>
          <p v-if="!stats.byOperation?.length" class="empty-inline">暂无操作数据</p>
          <div v-for="row in stats.byOperation || []" :key="row.operation_type" class="bar-row secondary">
            <div>
              <span>{{ operationNames[row.operation_type] || row.operation_type }}</span
              ><strong>{{ row.operation_count }}</strong>
            </div>
            <span class="bar-track"
              ><i :style="{ width: percent(row.operation_count, maxOperation) }"
            /></span>
          </div>
        </div>
      </div>

      <div v-if="stats.recentActivity?.length" class="activity-chart" aria-label="近期操作趋势">
        <div class="activity-heading">
          <h3>最近 7 天</h3>
          <span>每天记录的协作操作次数</span>
        </div>
        <div class="activity-bars">
          <div
            v-for="row in stats.recentActivity"
            :key="row.activity_date"
            class="activity-day"
            :aria-label="`${row.activity_date}：${row.operation_count} 次操作`"
          >
            <span class="activity-value">{{ row.operation_count }}</span>
            <i :style="{ height: percent(row.operation_count, maxRecent) }" aria-hidden="true" />
            <time :datetime="String(row.activity_date)">{{ String(row.activity_date).slice(5) }}</time>
          </div>
        </div>
      </div>
      <div v-if="stats.contributors?.length" class="contributors">
        <h3>参与协作的成员</h3>
        <div class="contributor-list">
          <span v-for="person in stats.contributors" :key="person.actor_id ?? person.actor_name"
            ><strong>{{ person.actor_name || '未知成员' }}</strong
            ><em>{{ person.operation_count }} 次</em></span
          >
        </div>
      </div>
      <p class="stats-count-note">次数按保存的编辑操作统计，包含系统初始化；不代表任务完成度。</p>
    </template>
    <div v-else class="panel-state">统计数据暂不可用</div>
  </section>
</template>
