<script setup>
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  GripVertical,
  LayoutDashboard,
  Plus,
  Trash2,
} from 'lucide-vue-next'
import { fieldValue } from '../collab/collabState.js'
import { elementPatch } from '../collab/elementValues.js'
import { compareElementOrder } from '../collab/ordering.js'
import { planInsertionOrder } from '../collab/insertionOrder.js'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import AssetImage from '../components/AssetImage.vue'
import ImageUpload from '../components/ImageUpload.vue'
import '../styles/kanban-polish.css'

const props = defineProps({ collab: { type: Object, required: true } })
const editor = ref(null)
const boardScroll = ref(null)
const navigationNotice = ref('')
const drag = reactive({
  active: false,
  cardId: '',
  pointerId: null,
  sourceColumn: '',
  targetColumn: '',
  targetCardId: '',
  targetIndex: 0,
})
const pendingColumn = ref(null)
const compositionDrafts = reactive({})
const titleDrafts = reactive({})
const composingTitles = new Set()
const colors = ['#ffffff', '#fff1c9', '#dff3e5', '#e2edff']
let colorIndex = 0
let navigationGeneration = 0

const hasEditingRole = computed(() => ['owner', 'admin', 'editor'].includes(props.collab.role.value))

const columns = computed(() => {
  props.collab.stateVersion.value
  return [...props.collab.state.elements.values()]
    .filter((element) => element.type === 'COLUMN')
    .sort((left, right) => compareElementOrder(left, right))
})
const cards = computed(() => {
  props.collab.stateVersion.value
  return [...props.collab.state.elements.values()]
    .filter((element) => element.type === 'CARD')
    .sort((left, right) => compareElementOrder(left, right))
})
const columnOptions = computed(() =>
  columns.value.map((column, index) => ({
    id: column.id,
    name: `${index + 1}. ${String(fieldValue(column, 'title', '')).trim() || '未命名列表'}`,
    count: cardsFor(column.id).length,
  })),
)

function cardsFor(columnId) {
  return cards.value.filter((card) => String(fieldValue(card, 'column', '')) === columnId)
}

function updateElement(id, type, changes) {
  if (!props.collab.canEdit.value) return false
  const values = elementPatch(props.collab.state, id, type, changes)
  return values !== null && props.collab.setElement(id, type, values)
}

function cardText(card) {
  return Object.hasOwn(compositionDrafts, card.id) ? compositionDrafts[card.id] : fieldValue(card, 'text', '')
}

function updateText(card, event) {
  const text = event.target.value
  if (event.isComposing || Object.hasOwn(compositionDrafts, card.id)) {
    compositionDrafts[card.id] = text
  } else if (fieldValue(props.collab.state.elements.get(card.id), 'text', '') !== text) {
    updateElement(card.id, 'CARD', { text })
  }
}

function finishComposition(card, event) {
  delete compositionDrafts[card.id]
  updateText(card, event)
}

function columnTitle(column) {
  return Object.hasOwn(titleDrafts, column.id)
    ? titleDrafts[column.id]
    : fieldValue(column, 'title', '未命名列表')
}

function commitColumnTitle(column, event) {
  if (composingTitles.has(column.id)) return
  const title = event.target.value.trim() || '未命名列表'
  const current = props.collab.state.elements.get(column.id)
  if (current && fieldValue(current, 'title', '未命名列表') !== title) {
    if (!updateElement(column.id, 'COLUMN', { title })) return
  }
  delete titleDrafts[column.id]
  event.target.value = fieldValue(props.collab.state.elements.get(column.id), 'title', '未命名列表')
}

function columnTitleKeydown(column, event) {
  if (event.isComposing || event.keyCode === 229 || composingTitles.has(column.id)) return
  if (event.key === 'Enter') {
    event.preventDefault()
    event.currentTarget.blur()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    delete titleDrafts[column.id]
    event.currentTarget.value = fieldValue(props.collab.state.elements.get(column.id), 'title', '未命名列表')
    event.currentTarget.blur()
  }
}

function insertionOrder(elements, index) {
  const plan = planInsertionOrder(elements, index)
  for (const update of plan.updates) {
    if (!updateElement(update.id, update.type, { order: update.order })) return null
  }
  return plan.order
}

async function focusCreated(id, type) {
  await nextTick()
  if (!props.collab.canEdit.value) return
  const selector =
    type === 'COLUMN'
      ? `[data-column-id="${CSS.escape(id)}"] input`
      : `[data-card-id="${CSS.escape(id)}"] textarea`
  const field = editor.value?.querySelector(selector)
  field?.focus()
  if (type === 'COLUMN') field?.select()
}

async function addColumn() {
  if (!props.collab.canEdit.value) return
  const id = `column-${crypto.randomUUID()}`
  const order = insertionOrder(columns.value, columns.value.length)
  if (order === null) return
  if (props.collab.setElement(id, 'COLUMN', { title: `新列表 ${columns.value.length + 1}`, order })) {
    await focusCreated(id, 'COLUMN')
  }
}

async function addCard(columnId) {
  if (!props.collab.canEdit.value) return
  if (!columns.value.some((column) => column.id === columnId)) return
  const list = cardsFor(columnId)
  const id = `card-${crypto.randomUUID()}`
  const order = insertionOrder(list, list.length)
  if (order === null) return
  if (
    !props.collab.setElement(id, 'CARD', {
      column: columnId,
      order,
      text: '',
      color: colors[colorIndex % colors.length],
    })
  )
    return
  colorIndex += 1
  await focusCreated(id, 'CARD')
}

function removeColumn(column) {
  if (!props.collab.canEdit.value || !props.collab.state.elements.has(column.id)) return
  pendingColumn.value = column
}

function confirmRemoveColumn() {
  const column = pendingColumn.value
  if (!column || !props.collab.canEdit.value || !props.collab.state.elements.has(column.id)) {
    pendingColumn.value = null
    return
  }
  for (const card of cardsFor(column.id)) {
    if (!props.collab.deleteElement(card.id, 'CARD')) return
  }
  if (!props.collab.deleteElement(column.id, 'COLUMN')) return
  pendingColumn.value = null
}

function moveColumn(column, direction) {
  if (!props.collab.canEdit.value) return
  const index = columns.value.findIndex((item) => item.id === column.id)
  const targetIndex = index + direction
  if (index < 0 || targetIndex < 0 || targetIndex >= columns.value.length) return
  const others = columns.value.filter((item) => item.id !== column.id)
  const order = insertionOrder(others, targetIndex)
  if (order !== null) updateElement(column.id, 'COLUMN', { order })
}

function moveCardAcross(card, direction) {
  if (!props.collab.canEdit.value) return
  card = props.collab.state.elements.get(card.id)
  if (!card || card.type !== 'CARD') return
  const currentColumn = String(fieldValue(card, 'column', ''))
  const index = columns.value.findIndex((column) => column.id === currentColumn)
  const target = columns.value[index + direction]
  if (index < 0 || !target) return
  moveCardTo(card, target.id)
}

function moveCardTo(card, columnId, requestedIndex = null) {
  if (!props.collab.canEdit.value) return false
  card = props.collab.state.elements.get(card.id)
  if (!card || card.type !== 'CARD' || !columns.value.some((column) => column.id === columnId)) return false
  const sourceColumn = String(fieldValue(card, 'column', ''))
  const targetCards = cardsFor(columnId).filter((item) => item.id !== card.id)
  const index =
    requestedIndex == null ? targetCards.length : Math.max(0, Math.min(requestedIndex, targetCards.length))
  if (sourceColumn === columnId && cardsFor(columnId).findIndex((item) => item.id === card.id) === index)
    return false
  const order = insertionOrder(targetCards, index)
  return order !== null && updateElement(card.id, 'CARD', { column: columnId, order })
}

function revealColumn(columnId) {
  const scroll = boardScroll.value
  const column = editor.value?.querySelector(`[data-column-id="${CSS.escape(columnId)}"]`)
  if (!scroll || !column) return false
  const padding = Number.parseFloat(getComputedStyle(scroll).paddingLeft) || 0
  scroll.scrollTo({
    left:
      scroll.scrollLeft + column.getBoundingClientRect().left - scroll.getBoundingClientRect().left - padding,
    top: scroll.scrollTop,
    behavior: 'instant',
  })
  return true
}

function jumpToColumn(event) {
  const columnId = event.currentTarget.value
  event.currentTarget.value = ''
  const option = columnOptions.value.find((column) => column.id === columnId)
  if (!option || !revealColumn(columnId)) return
  navigationGeneration += 1
  navigationNotice.value = `已定位到列表 ${option.name}，${option.count} 项任务`
}

async function moveCardFromSelect(card, event) {
  const columnId = event.currentTarget.value
  const current = props.collab.state.elements.get(card.id)
  const sourceColumn = String(fieldValue(current, 'column', ''))
  // Restore the bound value even if permission or a remote deletion invalidates
  // a choice made while the native list of options was open.
  event.currentTarget.value = sourceColumn
  if (sourceColumn === columnId || !moveCardTo(card, columnId)) return
  const generation = ++navigationGeneration
  await nextTick()
  if (generation !== navigationGeneration || !props.collab.canEdit.value) return
  const moved = props.collab.state.elements.get(card.id)
  if (!moved || String(fieldValue(moved, 'column', '')) !== columnId) return
  const element = editor.value?.querySelector(`[data-card-id="${CSS.escape(card.id)}"]`)
  if (!element || !revealColumn(columnId)) return
  const list = element.closest('.kanban-cards')
  const bounds = element.getBoundingClientRect()
  const viewport = list.getBoundingClientRect()
  if (bounds.bottom > viewport.bottom) list.scrollTop += bounds.bottom - viewport.bottom
  if (bounds.top < viewport.top) list.scrollTop += bounds.top - viewport.top
  element.querySelector('.kanban-card-destination select')?.focus({ preventScroll: true })
  navigationNotice.value = `卡片已移至列表 ${columnOptions.value.find((column) => column.id === columnId)?.name || ''}`
}

function reorderCard(card, direction) {
  if (!props.collab.canEdit.value) return
  card = props.collab.state.elements.get(card.id)
  if (!card || card.type !== 'CARD') return
  const list = cardsFor(String(fieldValue(card, 'column', '')))
  const index = list.findIndex((item) => item.id === card.id)
  const other = list[index + direction]
  if (!other) return
  moveCardTo(card, String(fieldValue(card, 'column', '')), index + direction)
}

function startDrag(event, card) {
  if (!props.collab.canEdit.value || event.button !== 0) return
  card = props.collab.state.elements.get(card.id)
  if (!card || card.type !== 'CARD') return
  cancelDrag()
  drag.active = true
  drag.cardId = card.id
  drag.pointerId = event.pointerId
  drag.sourceColumn = String(fieldValue(card, 'column', ''))
  drag.targetColumn = drag.sourceColumn
  drag.targetCardId = ''
  drag.targetIndex = Math.max(
    0,
    cardsFor(drag.sourceColumn).findIndex((item) => item.id === card.id),
  )
  document.body.classList.add('kanban-dragging')
  window.addEventListener('pointermove', trackDrag)
  window.addEventListener('pointerup', endDrag)
  window.addEventListener('pointercancel', cancelDrag)
  window.addEventListener('blur', cancelDrag)
  window.addEventListener('keydown', cancelDragOnEscape)
}

function trackDrag(event) {
  if (!drag.active || event.pointerId !== drag.pointerId) return
  if (!props.collab.canEdit.value || !props.collab.state.elements.has(drag.cardId)) return cancelDrag()
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-column-id]')
  if (!target || !editor.value?.contains(target)) {
    drag.targetColumn = ''
    drag.targetCardId = ''
    return
  }
  drag.targetColumn = target.dataset.columnId
  const targetCards = cardsFor(drag.targetColumn).filter((item) => item.id !== drag.cardId)
  const cardElement = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-card-id]')
  if (cardElement?.dataset.cardId === drag.cardId) {
    drag.targetCardId = ''
    drag.targetIndex = Math.max(
      0,
      cardsFor(drag.sourceColumn).findIndex((item) => item.id === drag.cardId),
    )
    return
  }
  if (!cardElement) {
    drag.targetCardId = ''
    drag.targetIndex = targetCards.length
    return
  }
  drag.targetCardId = cardElement.dataset.cardId
  const anchorIndex = targetCards.findIndex((item) => item.id === drag.targetCardId)
  const rect = cardElement.getBoundingClientRect()
  drag.targetIndex = Math.max(0, anchorIndex + (event.clientY > rect.top + rect.height / 2 ? 1 : 0))
}

function endDrag(event) {
  if (!drag.active || event.pointerId !== drag.pointerId) return
  const card = cards.value.find((item) => item.id === drag.cardId)
  if (card && drag.targetColumn && props.collab.canEdit.value)
    moveCardTo(card, drag.targetColumn, drag.targetIndex)
  cancelDrag()
}

function cancelDrag() {
  drag.active = false
  drag.cardId = ''
  drag.pointerId = null
  drag.targetColumn = ''
  drag.targetCardId = ''
  document.body.classList.remove('kanban-dragging')
  window.removeEventListener('pointermove', trackDrag)
  window.removeEventListener('pointerup', endDrag)
  window.removeEventListener('pointercancel', cancelDrag)
  window.removeEventListener('blur', cancelDrag)
  window.removeEventListener('keydown', cancelDragOnEscape)
}

function cancelDragOnEscape(event) {
  if (event.key !== 'Escape') return
  event.preventDefault()
  cancelDrag()
}

function setCover(card, asset) {
  updateElement(card.id, 'CARD', {
    coverId: asset?.assetId ?? null,
    coverName: asset?.name ?? null,
    coverUrl: asset?.url ?? null,
  })
}

watch(
  () => [props.collab.canEdit.value, props.collab.stateVersion.value],
  () => {
    if (
      drag.active &&
      (!props.collab.canEdit.value ||
        !props.collab.state.elements.has(drag.cardId) ||
        !props.collab.state.elements.has(drag.sourceColumn) ||
        (drag.targetColumn && !props.collab.state.elements.has(drag.targetColumn)))
    )
      cancelDrag()
    if (
      pendingColumn.value &&
      (!props.collab.canEdit.value || !props.collab.state.elements.has(pendingColumn.value.id))
    ) {
      pendingColumn.value = null
    }
    for (const id of Object.keys(compositionDrafts)) {
      if (!props.collab.canEdit.value || !props.collab.state.elements.has(id)) delete compositionDrafts[id]
    }
    for (const id of Object.keys(titleDrafts)) {
      if (!props.collab.canEdit.value || !props.collab.state.elements.has(id)) {
        delete titleDrafts[id]
        composingTitles.delete(id)
      }
    }
  },
  { flush: 'sync' },
)

onBeforeUnmount(() => {
  navigationGeneration += 1
  cancelDrag()
})
</script>

<template>
  <div ref="editor" class="kanban-editor">
    <div class="kanban-tools">
      <button v-if="collab.canEdit.value" class="button primary" type="button" @click="addColumn">
        <Plus :size="17" />添加列表
      </button>
      <label v-if="columns.length" class="kanban-column-navigation">
        <span>跳转列表</span>
        <select value="" aria-label="跳转列表" @change="jumpToColumn">
          <option value="" disabled>选择列表</option>
          <option v-for="column in columnOptions" :key="column.id" :value="column.id">
            {{ column.name }}（{{ column.count }} 项）
          </option>
        </select>
      </label>
      <span class="kanban-summary">{{ columns.length }} 个列表 · {{ cards.length }} 张卡片</span>
    </div>
    <p class="kanban-navigation-notice" role="status" aria-live="polite">{{ navigationNotice }}</p>
    <div ref="boardScroll" class="kanban-scroll" role="region" aria-label="看板列表">
      <div class="kanban-board">
        <section
          v-for="(column, columnIndex) in columns"
          :key="column.id"
          class="kanban-column"
          :class="{ 'drop-target': drag.active && drag.targetColumn === column.id }"
          :data-column-id="column.id"
        >
          <header class="kanban-column-head">
            <input
              :value="columnTitle(column)"
              :readonly="!collab.canEdit.value"
              aria-label="列表标题"
              maxlength="80"
              @input="titleDrafts[column.id] = $event.target.value"
              @change="commitColumnTitle(column, $event)"
              @blur="commitColumnTitle(column, $event)"
              @compositionstart="composingTitles.add(column.id)"
              @compositionend="composingTitles.delete(column.id)"
              @keydown="columnTitleKeydown(column, $event)"
            />
            <span>{{ cardsFor(column.id).length }}</span>
            <div v-if="collab.canEdit.value" class="column-actions">
              <button
                class="icon-button subtle"
                type="button"
                aria-label="向左移动列表"
                :disabled="columnIndex === 0"
                @click="moveColumn(column, -1)"
              >
                <ChevronLeft :size="15" />
              </button>
              <button
                class="icon-button subtle"
                type="button"
                aria-label="向右移动列表"
                :disabled="columnIndex === columns.length - 1"
                @click="moveColumn(column, 1)"
              >
                <ChevronRight :size="15" />
              </button>
              <button
                class="icon-button subtle danger-on-hover"
                type="button"
                aria-label="删除列表"
                @click="removeColumn(column)"
              >
                <Trash2 :size="15" />
              </button>
            </div>
          </header>

          <div class="kanban-cards">
            <article
              v-for="(card, cardIndex) in cardsFor(column.id)"
              :key="card.id"
              class="kanban-card"
              :class="{
                dragging: drag.active && drag.cardId === card.id,
                'drop-anchor': drag.active && drag.targetCardId === card.id,
              }"
              :style="{ background: fieldValue(card, 'color', '#ffffff') }"
              :data-card-id="card.id"
            >
              <button
                v-if="collab.canEdit.value"
                class="card-grip"
                type="button"
                aria-label="拖动卡片"
                @pointerdown.prevent="startDrag($event, card)"
              >
                <GripVertical :size="16" />
              </button>
              <div v-if="fieldValue(card, 'coverId', '')" class="kanban-cover-frame">
                <AssetImage
                  class="kanban-cover"
                  :asset-id="fieldValue(card, 'coverId', '')"
                  :alt="fieldValue(card, 'coverName', '任务封面')"
                />
              </div>
              <div v-if="collab.canEdit.value" class="kanban-image-tools">
                <ImageUpload
                  :doc-id="collab.docId"
                  :label="fieldValue(card, 'coverId', '') ? '替换封面' : '上传封面'"
                  :disabled="!collab.canEdit.value"
                  @uploaded="setCover(card, $event)"
                />
                <button
                  v-if="fieldValue(card, 'coverId', '')"
                  class="icon-button"
                  type="button"
                  aria-label="移除封面"
                  @click="setCover(card, null)"
                >
                  <Trash2 :size="15" />
                </button>
              </div>
              <textarea
                :value="cardText(card)"
                :readonly="!collab.canEdit.value"
                rows="3"
                aria-label="任务卡片内容"
                placeholder="输入任务内容"
                @input="updateText(card, $event)"
                @compositionstart="compositionDrafts[card.id] = $event.target.value"
                @compositionend="finishComposition(card, $event)"
              />
              <label v-if="hasEditingRole" class="kanban-card-destination">
                <span>移至列表</span>
                <select
                  :value="String(fieldValue(card, 'column', ''))"
                  :disabled="!collab.canEdit.value || columns.length < 2"
                  aria-label="移至列表"
                  @change="moveCardFromSelect(card, $event)"
                >
                  <option v-for="target in columnOptions" :key="target.id" :value="target.id">
                    {{ target.name }}
                  </option>
                </select>
              </label>
              <div v-if="collab.canEdit.value" class="kanban-card-actions">
                <button
                  class="icon-button subtle"
                  type="button"
                  aria-label="移到上一列表"
                  title="移到上一列表"
                  :disabled="columnIndex === 0"
                  @click="moveCardAcross(card, -1)"
                >
                  <ChevronLeft :size="15" />
                </button>
                <button
                  class="icon-button subtle"
                  type="button"
                  aria-label="卡片上移"
                  title="卡片上移"
                  :disabled="cardIndex === 0"
                  @click="reorderCard(card, -1)"
                >
                  <ChevronUp :size="15" />
                </button>
                <button
                  class="icon-button subtle"
                  type="button"
                  aria-label="卡片下移"
                  title="卡片下移"
                  :disabled="cardIndex === cardsFor(column.id).length - 1"
                  @click="reorderCard(card, 1)"
                >
                  <ChevronDown :size="15" />
                </button>
                <button
                  class="icon-button subtle"
                  type="button"
                  aria-label="移到下一列表"
                  title="移到下一列表"
                  :disabled="columnIndex === columns.length - 1"
                  @click="moveCardAcross(card, 1)"
                >
                  <ChevronRight :size="15" />
                </button>
                <button
                  class="icon-button subtle danger-on-hover"
                  type="button"
                  aria-label="删除卡片"
                  title="删除卡片"
                  @click="collab.deleteElement(card.id, 'CARD')"
                >
                  <Trash2 :size="15" />
                </button>
              </div>
            </article>
            <p v-if="!cardsFor(column.id).length" class="column-empty">暂无卡片</p>
          </div>
          <button
            v-if="collab.canEdit.value"
            class="add-card-button"
            type="button"
            @click="addCard(column.id)"
          >
            <Plus :size="16" />添加卡片
          </button>
        </section>

        <button
          v-if="collab.canEdit.value && columns.length"
          class="add-column-tile"
          type="button"
          @click="addColumn"
        >
          <Plus :size="18" />添加列表
        </button>
        <div v-if="!columns.length" class="kanban-empty">
          <LayoutDashboard :size="27" />
          <p>{{ collab.canEdit.value ? '创建第一个看板列表' : '看板还没有列表' }}</p>
          <button v-if="collab.canEdit.value" class="button primary" type="button" @click="addColumn">
            <Plus :size="17" />添加列表
          </button>
        </div>
      </div>
    </div>
    <ConfirmDialog
      v-if="pendingColumn"
      title="删除列表"
      :description="`确定删除列表“${fieldValue(pendingColumn, 'title', '未命名列表')}”及其中所有卡片？`"
      confirm-label="删除列表"
      danger
      @cancel="pendingColumn = null"
      @confirm="confirmRemoveColumn"
    />
  </div>
</template>
