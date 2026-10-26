<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, useId, watch } from 'vue'
import {
  BringToFront,
  Hand,
  GripHorizontal,
  Layers,
  Maximize2,
  Minus,
  MoveDiagonal2,
  Palette,
  Pencil,
  Plus,
  SendToBack,
  StickyNote,
  Trash2,
} from 'lucide-vue-next'
import { fieldValue } from '../collab/collabState.js'
import { elementPatch } from '../collab/elementValues.js'
import { compareElementOrder } from '../collab/ordering.js'
import AssetImage from '../components/AssetImage.vue'
import ImageUpload from '../components/ImageUpload.vue'
import ActionMenu from '../components/ActionMenu.vue'
import {
  boardContentBounds,
  boardFitView,
  boardPointAt,
  boardRect,
  boardScale,
  boardZoomScroll,
  MAX_BOARD_SCALE,
  MIN_BOARD_SCALE,
} from '../lib/boardViewport.js'
import '../styles/board-viewport.css'

const props = defineProps({ collab: { type: Object, required: true } })
const editor = ref(null)
const canvas = ref(null)
const viewport = ref(null)
const zoom = ref(1)
const viewSize = reactive({ width: 0, height: 0 })
const viewPadding = ref(false)
const panTool = ref(false)
const spaceHeld = ref(false)
const pan = reactive({ active: false, pointerId: null, startX: 0, startY: 0, left: 0, top: 0 })
const navigationHintId = useId()
let viewportObserver = null
let viewportInitialized = false
let viewGeneration = 0
let unmounted = false
const selectedId = ref('')
const drafts = reactive({})
const compositionDrafts = reactive({})
const pointer = reactive({
  active: false,
  id: '',
  pointerId: null,
  mode: '',
  startX: 0,
  startY: 0,
  x: 0,
  y: 0,
  w: 0,
  h: 0,
})
let pointerTarget = null
const colors = ['#fff1a8', '#dff4e4', '#dcecff', '#f8dfe6']
let colorIndex = 0

const cards = computed(() => {
  props.collab.stateVersion.value
  return [...props.collab.state.elements.values()]
    .filter((element) => ['CARD', 'IMAGE'].includes(element.type))
    .sort((left, right) => compareElementOrder(left, right, 'z'))
})
const selected = computed(() => cards.value.find((card) => card.id === selectedId.value) || null)
const selectedIsFront = computed(
  () =>
    selected.value &&
    cards.value.every((card) => card.id === selected.value.id || layerOf(selected.value) > layerOf(card)),
)
const selectedIsBack = computed(
  () =>
    selected.value &&
    cards.value.every((card) => card.id === selected.value.id || layerOf(selected.value) < layerOf(card)),
)
const zoomOptions = computed(() =>
  [...new Set([10, 25, 50, 75, 100, 125, 150, 200, Math.round(zoom.value * 100)])].sort((a, b) => a - b),
)
const worldSize = computed(() => {
  const bounds = boardContentBounds(cards.value.map(geometry))
  return {
    width: Math.max(1400, (bounds?.right || 0) + 160),
    height: Math.max(900, (bounds?.bottom || 0) + 160),
  }
})
const planeStyle = computed(() => ({
  width: `${worldSize.value.width * zoom.value + (viewPadding.value ? viewSize.width : 0)}px`,
  height: `${worldSize.value.height * zoom.value + (viewPadding.value ? viewSize.height : 0)}px`,
}))
const canvasStyle = computed(() => ({
  width: `${worldSize.value.width}px`,
  height: `${worldSize.value.height}px`,
  left: `${viewPadding.value ? viewSize.width / 2 : 0}px`,
  top: `${viewPadding.value ? viewSize.height / 2 : 0}px`,
  transform: `scale(${zoom.value})`,
  backgroundSize: `${22 / zoom.value}px ${22 / zoom.value}px`,
  backgroundImage: `radial-gradient(#d1d7e2 ${0.7 / zoom.value}px, transparent ${0.8 / zoom.value}px)`,
}))

function currentView() {
  return {
    width: viewSize.width,
    height: viewSize.height,
    originX: viewPadding.value ? viewSize.width / 2 : 0,
    originY: viewPadding.value ? viewSize.height / 2 : 0,
    scrollLeft: viewport.value?.scrollLeft || 0,
    scrollTop: viewport.value?.scrollTop || 0,
  }
}

function pointerPosition(event) {
  const bounds = viewport.value.getBoundingClientRect()
  return boardPointAt(
    { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
    currentView(),
    zoom.value,
  )
}

function insertionPosition(offset = 0) {
  const point = boardPointAt({ x: 56 + offset, y: 56 + offset }, currentView(), zoom.value)
  return { x: Math.max(0, Math.round(point.x)), y: Math.max(0, Math.round(point.y)) }
}

async function setZoom(value, anchor = null) {
  const scale = boardScale(value)
  if (Math.abs(scale - zoom.value) < 0.0001) return
  const position = boardZoomScroll(currentView(), zoom.value, scale, anchor, {
    x: viewSize.width / 2,
    y: viewSize.height / 2,
  })
  viewPadding.value = true
  cancelPointer()
  cancelPan()
  const generation = ++viewGeneration
  zoom.value = scale
  await nextTick()
  if (!unmounted && generation === viewGeneration) viewport.value?.scrollTo(position)
}

function zoomStep(direction) {
  const options = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]
  const next =
    direction > 0
      ? (options.find((value) => value > zoom.value + 0.0001) ?? MAX_BOARD_SCALE)
      : (options.findLast((value) => value < zoom.value - 0.0001) ?? MIN_BOARD_SCALE)
  setZoom(next)
}

async function fitContents() {
  cancelPointer()
  cancelPan()
  viewPadding.value = true
  const position = boardFitView(cards.value.map(geometry), currentView(), viewSize.width < 600 ? 24 : 40)
  const generation = ++viewGeneration
  zoom.value = position.scale
  await nextTick()
  if (!unmounted && generation === viewGeneration)
    viewport.value?.scrollTo({ left: position.left, top: position.top })
}

function zoomWheel(event) {
  if (!event.ctrlKey && !event.metaKey) return
  event.preventDefault()
  const bounds = viewport.value.getBoundingClientRect()
  setZoom(zoom.value * Math.exp(-event.deltaY * 0.002), {
    x: event.clientX - bounds.left,
    y: event.clientY - bounds.top,
  })
}

function textControl(target) {
  return (
    target instanceof Element &&
    target.closest('input, textarea, select, button, a, [contenteditable="true"]')
  )
}

function navigationKeydown(event) {
  if (
    !editor.value?.contains(event.target) ||
    textControl(event.target) ||
    event.isComposing ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey
  )
    return
  if (event.code === 'Space') {
    event.preventDefault()
    spaceHeld.value = true
  } else if (event.key === '+' || event.key === '=') {
    event.preventDefault()
    zoomStep(1)
  } else if (event.key === '-') {
    event.preventDefault()
    zoomStep(-1)
  } else if (event.key === '0') {
    event.preventDefault()
    setZoom(1)
  } else if (event.key === 'Escape') cancelPan()
}

function navigationKeyup(event) {
  if (event.code !== 'Space') return
  spaceHeld.value = false
  if (pan.active) cancelPan()
}

function startPan(event) {
  if (event.button !== 1 && !(event.button === 0 && (panTool.value || spaceHeld.value))) return
  if (event.target.closest('button, input, select, a')) return
  if (!panTool.value && textControl(event.target)) return
  event.preventDefault()
  event.stopPropagation()
  cancelPointer()
  cancelPan()
  Object.assign(pan, {
    active: true,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    left: viewport.value.scrollLeft,
    top: viewport.value.scrollTop,
  })
  viewport.value.setPointerCapture?.(event.pointerId)
  viewport.value.focus({ preventScroll: true })
}

function movePan(event) {
  if (!pan.active || event.pointerId !== pan.pointerId) return
  event.preventDefault()
  viewport.value.scrollLeft = pan.left - (event.clientX - pan.startX)
  viewport.value.scrollTop = pan.top - (event.clientY - pan.startY)
}

function endPan(event) {
  if (pan.active && event.pointerId === pan.pointerId) cancelPan()
}

function cancelPan() {
  const pointerId = pan.pointerId
  pan.active = false
  pan.pointerId = null
  if (viewport.value?.hasPointerCapture?.(pointerId)) viewport.value.releasePointerCapture(pointerId)
}

function togglePanTool() {
  cancelPointer()
  cancelPan()
  panTool.value = !panTool.value
}

function windowBlur() {
  spaceHeld.value = false
  cancelPointer()
  cancelPan()
}

function canvasDoubleClick(event) {
  if (panTool.value || spaceHeld.value || event.target.closest('.board-card')) return
  addCard(event)
}

function layerOf(card) {
  const layer = Number(fieldValue(card, 'z', 0))
  return Number.isFinite(layer) ? layer : 0
}

function geometry(card) {
  return (
    drafts[card.id] ||
    boardRect({
      x: Number(fieldValue(card, 'x', 48)),
      y: Number(fieldValue(card, 'y', 48)),
      w: Number(fieldValue(card, 'w', 220)),
      h: Number(fieldValue(card, 'h', 150)),
    })
  )
}

function cardStyle(card) {
  const item = geometry(card)
  return {
    transform: `translate(${item.x}px, ${item.y}px)`,
    width: `${item.w}px`,
    height: `${item.h}px`,
    zIndex: Number(fieldValue(card, 'z', 1)),
    background: fieldValue(card, 'color', colors[0]),
  }
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

function topLayer() {
  return Math.max(0, ...cards.value.map(layerOf)) + 1
}

async function addCard(event) {
  if (!props.collab.canEdit.value) return
  const id = `card-${crypto.randomUUID()}`
  const offset = (cards.value.length % 6) * 28
  const point = event?.type === 'dblclick' ? pointerPosition(event) : insertionPosition(offset)
  const x = Math.max(0, Math.round(point.x))
  const y = Math.max(0, Math.round(point.y))
  if (
    !props.collab.setElement(id, 'CARD', {
      x,
      y,
      w: 220,
      h: 150,
      z: topLayer(),
      text: '',
      color: colors[colorIndex % colors.length],
    })
  )
    return
  colorIndex += 1
  selectedId.value = id
  await nextTick()
  if (!props.collab.canEdit.value) return
  canvas.value?.querySelector(`[data-card-id="${CSS.escape(id)}"] textarea`)?.focus()
}

function selectCard(card) {
  if (!props.collab.state.elements.has(card.id)) return
  selectedId.value = card.id
}

function moveLayer(edge) {
  if (!props.collab.canEdit.value || !selected.value || cards.value.length < 2) return
  const layers = cards.value.map(layerOf)
  const nextLayer = edge === 'front' ? Math.max(...layers) + 1 : Math.min(...layers) - 1
  updateElement(selected.value.id, selected.value.type, { z: nextLayer })
}

function startPointer(event, card, mode) {
  if (!props.collab.canEdit.value || event.button !== 0 || panTool.value || spaceHeld.value || pan.active)
    return
  if (mode === 'move' && event.target.closest('textarea, button')) return
  if (!props.collab.state.elements.has(card.id)) return
  cancelPointer()
  event.preventDefault()
  selectCard(card)
  const item = geometry(card)
  const start = pointerPosition(event)
  Object.assign(pointer, {
    active: true,
    id: card.id,
    pointerId: event.pointerId,
    mode,
    startX: start.x,
    startY: start.y,
    x: item.x,
    y: item.y,
    w: item.w,
    h: item.h,
  })
  pointerTarget = event.currentTarget
  pointerTarget.setPointerCapture?.(event.pointerId)
  window.addEventListener('blur', cancelPointer)
  window.addEventListener('keydown', cancelPointerOnEscape)
}

function movePointer(event) {
  if (!pointer.active || event.pointerId !== pointer.pointerId) return
  if (!props.collab.canEdit.value || !props.collab.state.elements.has(pointer.id)) return cancelPointer()
  const current = pointerPosition(event)
  const dx = current.x - pointer.startX
  const dy = current.y - pointer.startY
  if (pointer.mode === 'resize') {
    drafts[pointer.id] = {
      x: pointer.x,
      y: pointer.y,
      w: Math.max(150, pointer.w + dx),
      h: Math.max(110, pointer.h + dy),
    }
  } else {
    drafts[pointer.id] = {
      x: Math.max(0, pointer.x + dx),
      y: Math.max(0, pointer.y + dy),
      w: pointer.w,
      h: pointer.h,
    }
  }
}

function endPointer(event) {
  if (!pointer.active || event.pointerId !== pointer.pointerId) return
  const item = drafts[pointer.id]
  if (item && props.collab.canEdit.value) {
    const card = cards.value.find((card) => card.id === pointer.id)
    const fields = pointer.mode === 'resize' ? ['w', 'h'] : ['x', 'y']
    const changes = Object.fromEntries(fields.map((field) => [field, Math.round(item[field])]))
    if (card && fields.some((field) => changes[field] !== Number(fieldValue(card, field)))) {
      updateElement(card.id, card.type, changes)
    }
  }
  cancelPointer()
}

function cancelPointer() {
  const target = pointerTarget
  const pointerId = pointer.pointerId
  delete drafts[pointer.id]
  pointer.active = false
  pointer.id = ''
  pointer.pointerId = null
  pointerTarget = null
  window.removeEventListener('blur', cancelPointer)
  window.removeEventListener('keydown', cancelPointerOnEscape)
  if (target?.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId)
}

function cancelPointerOnEscape(event) {
  if (event.key !== 'Escape') return
  event.preventDefault()
  cancelPointer()
}

function nudge(card, event) {
  if (!props.collab.canEdit.value || event.target.closest('textarea, button')) return
  const delta = event.shiftKey ? 20 : 5
  const item = geometry(card)
  const moves = {
    ArrowLeft: [-delta, 0],
    ArrowRight: [delta, 0],
    ArrowUp: [0, -delta],
    ArrowDown: [0, delta],
  }
  if (!moves[event.key]) return
  event.preventDefault()
  updateElement(card.id, card.type, {
    x: Math.max(0, item.x + moves[event.key][0]),
    y: Math.max(0, item.y + moves[event.key][1]),
  })
}

function resizeByKey(card, event) {
  if (!props.collab.canEdit.value) return
  const delta = event.shiftKey ? 20 : 5
  const changes = {
    ArrowLeft: [-delta, 0],
    ArrowRight: [delta, 0],
    ArrowUp: [0, -delta],
    ArrowDown: [0, delta],
  }
  if (!changes[event.key]) return
  event.preventDefault()
  event.stopPropagation()
  const current = props.collab.state.elements.get(card.id)
  if (!current) return
  updateElement(current.id, current.type, {
    w: Math.max(150, Number(fieldValue(current, 'w', 220)) + changes[event.key][0]),
    h: Math.max(110, Number(fieldValue(current, 'h', 150)) + changes[event.key][1]),
  })
}

function setColor(color) {
  if (selected.value?.type === 'CARD') updateElement(selected.value.id, 'CARD', { color })
}

function cardActions(card) {
  return [
    ...(card.type === 'CARD'
      ? [
          { key: 'edit', label: '编辑内容', icon: Pencil },
          ...colors.map((color, index) => ({
            key: color,
            label: `改为${['黄色', '绿色', '蓝色', '粉色'][index]}`,
            icon: Palette,
          })),
        ]
      : []),
    {
      key: 'front',
      label: '置于顶层',
      icon: BringToFront,
      disabled: cards.value.every((other) => other.id === card.id || layerOf(card) > layerOf(other)),
    },
    {
      key: 'back',
      label: '置于底层',
      icon: SendToBack,
      disabled: cards.value.every((other) => other.id === card.id || layerOf(card) < layerOf(other)),
    },
    { key: 'delete', label: card.type === 'IMAGE' ? '删除图片' : '删除卡片', icon: Trash2, danger: true },
  ]
}

async function cardAction(card, action) {
  if (!props.collab.canEdit.value) return
  selectedId.value = card.id
  if (action === 'delete') props.collab.deleteElement(card.id, card.type)
  else if (action === 'front' || action === 'back') moveLayer(action)
  else if (colors.includes(action) && card.type === 'CARD') setColor(action)
  else if (action === 'edit') {
    await nextTick()
    canvas.value?.querySelector(`[data-card-id="${CSS.escape(card.id)}"] textarea`)?.focus()
  }
}
function insertImage(asset, existing = null) {
  if (!props.collab.canEdit.value) return
  const id = existing?.id || `image-${crypto.randomUUID()}`
  const saved = existing
    ? updateElement(id, 'IMAGE', asset)
    : props.collab.setElement(id, 'IMAGE', {
        ...asset,
        ...insertionPosition(),
        w: 280,
        h: Math.max(110, Math.round((280 * asset.height) / asset.width) + 32),
        z: topLayer(),
      })
  if (!saved) return
  selectedId.value = id
}

watch(
  () => [props.collab.canEdit.value, props.collab.stateVersion.value],
  () => {
    if (pointer.active && (!props.collab.canEdit.value || !props.collab.state.elements.has(pointer.id)))
      cancelPointer()
    if (selectedId.value && !props.collab.state.elements.has(selectedId.value)) selectedId.value = ''
    for (const id of Object.keys(compositionDrafts)) {
      if (!props.collab.canEdit.value || !props.collab.state.elements.has(id)) delete compositionDrafts[id]
    }
  },
  { flush: 'sync' },
)

onMounted(() => {
  viewportObserver = new ResizeObserver(async () => {
    if (!viewport.value) return
    const left = viewportInitialized ? viewport.value.scrollLeft : 0
    const top = viewportInitialized ? viewport.value.scrollTop : 0
    viewSize.width = viewport.value.clientWidth
    viewSize.height = viewport.value.clientHeight
    viewportInitialized = true
    const generation = viewGeneration
    await nextTick()
    if (!unmounted && generation === viewGeneration) viewport.value?.scrollTo({ left, top })
  })
  viewportObserver.observe(viewport.value)
  window.addEventListener('keydown', navigationKeydown)
  window.addEventListener('keyup', navigationKeyup)
  window.addEventListener('blur', windowBlur)
})

onBeforeUnmount(() => {
  unmounted = true
  viewGeneration += 1
  viewportObserver?.disconnect()
  window.removeEventListener('keydown', navigationKeydown)
  window.removeEventListener('keyup', navigationKeyup)
  window.removeEventListener('blur', windowBlur)
  cancelPointer()
  cancelPan()
})
</script>

<template>
  <div ref="editor" class="board-editor" :class="{ 'board-view-only': !collab.canEdit.value }">
    <div class="board-tools">
      <button v-if="collab.canEdit.value" class="button primary" type="button" @click="addCard">
        <Plus :size="17" />添加卡片
      </button>
      <ImageUpload
        v-if="collab.canEdit.value"
        :doc-id="collab.docId"
        :disabled="!collab.canEdit.value"
        @uploaded="insertImage($event)"
      />
      <ImageUpload
        v-if="collab.canEdit.value && selected?.type === 'IMAGE'"
        :key="selected.id"
        :doc-id="collab.docId"
        label="替换图片"
        :disabled="!collab.canEdit.value"
        @uploaded="insertImage($event, selected)"
      />
      <div
        v-if="collab.canEdit.value && selected?.type === 'CARD'"
        class="color-controls"
        aria-label="卡片颜色"
      >
        <span>卡片颜色</span>
        <button
          v-for="color in colors"
          :key="color"
          type="button"
          class="color-swatch"
          :class="{ active: fieldValue(selected, 'color', colors[0]) === color }"
          :style="{ background: color }"
          :aria-label="`使用颜色 ${color}`"
          @click="setColor(color)"
        />
      </div>
      <div v-if="collab.canEdit.value && selected" class="layer-controls" aria-label="卡片层级">
        <button
          class="icon-button subtle"
          type="button"
          aria-label="置于底层"
          title="置于底层"
          :disabled="cards.length < 2 || selectedIsBack"
          @click="moveLayer('back')"
        >
          <SendToBack :size="17" />
        </button>
        <button
          class="icon-button subtle"
          type="button"
          aria-label="置于顶层"
          title="置于顶层"
          :disabled="cards.length < 2 || selectedIsFront"
          @click="moveLayer('front')"
        >
          <BringToFront :size="17" />
        </button>
      </div>
      <span class="board-scale"><Layers :size="16" />{{ cards.length }} 张卡片</span>
    </div>
    <div class="board-stage">
      <div
        ref="viewport"
        class="board-scroll"
        :class="{ 'pan-mode': panTool || spaceHeld, panning: pan.active }"
        role="region"
        aria-label="白板画布"
        :aria-describedby="navigationHintId"
        tabindex="0"
        @pointerdown.capture="startPan"
        @pointermove="movePan"
        @pointerup="endPan"
        @pointercancel="endPan"
        @lostpointercapture="endPan"
        @wheel="zoomWheel"
        @dblclick="canvasDoubleClick"
      >
        <div class="board-plane" :style="planeStyle">
          <div ref="canvas" class="board-canvas" :style="canvasStyle">
            <div v-if="!cards.length" class="canvas-empty">
              <StickyNote :size="27" />
              <p>{{ collab.canEdit.value ? '添加第一张白板卡片' : '白板还没有卡片' }}</p>
            </div>
            <article
              v-for="card in cards"
              :key="card.id"
              class="board-card"
              :data-card-id="card.id"
              :class="{
                selected: selectedId === card.id,
                dragging: pointer.active && pointer.id === card.id,
              }"
              :style="cardStyle(card)"
              :tabindex="collab.canEdit.value ? 0 : -1"
              @pointerdown="startPointer($event, card, 'move')"
              @pointermove="movePointer"
              @pointerup="endPointer"
              @pointercancel="cancelPointer"
              @lostpointercapture="cancelPointer"
              @keydown="nudge(card, $event)"
              @click="selectCard(card)"
            >
              <div class="board-card-top" title="按住卡片顶部拖动">
                <ActionMenu
                  v-if="collab.canEdit.value"
                  align="start"
                  :label="card.type === 'IMAGE' ? '图片更多操作' : '卡片更多操作'"
                  :items="cardActions(card)"
                  @select="cardAction(card, $event)"
                />
                <GripHorizontal v-else class="card-drag-dots" :size="16" aria-hidden="true" />
                <button
                  v-if="collab.canEdit.value"
                  class="icon-button subtle danger-on-hover"
                  type="button"
                  :aria-label="card.type === 'IMAGE' ? '删除图片' : '删除卡片'"
                  @click.stop="collab.deleteElement(card.id, card.type)"
                >
                  <Trash2 :size="15" />
                </button>
              </div>
              <AssetImage
                v-if="card.type === 'IMAGE'"
                class="board-image"
                :asset-id="fieldValue(card, 'assetId', '')"
                :alt="fieldValue(card, 'name', '白板图片')"
              />
              <textarea
                v-else
                :value="cardText(card)"
                :readonly="!collab.canEdit.value"
                aria-label="卡片内容"
                placeholder="输入卡片内容"
                @input="updateText(card, $event)"
                @compositionstart="compositionDrafts[card.id] = $event.target.value"
                @compositionend="finishComposition(card, $event)"
                @pointerdown.stop
              />
              <button
                v-if="collab.canEdit.value"
                class="resize-handle"
                type="button"
                aria-label="调整卡片大小"
                title="拖动或使用方向键调整大小，Shift 加速"
                @pointerdown.stop="startPointer($event, card, 'resize')"
                @keydown="resizeByKey(card, $event)"
              >
                <MoveDiagonal2 :size="16" />
              </button>
            </article>
          </div>
        </div>
      </div>
      <p :id="navigationHintId" class="board-navigation-hint">空格 + 拖动平移 · Ctrl + 滚轮缩放</p>
      <div class="board-navigation" role="group" aria-label="白板视图">
        <button
          type="button"
          class="board-view-button"
          :class="{ active: panTool }"
          :aria-pressed="panTool"
          aria-label="平移白板"
          title="平移模式，可直接拖动画布"
          @click="togglePanTool"
        >
          <Hand :size="17" />
        </button>
        <span class="board-navigation-divider" aria-hidden="true" />
        <button
          type="button"
          class="board-view-button"
          aria-label="缩小白板"
          title="缩小"
          :disabled="zoom <= MIN_BOARD_SCALE"
          @click="zoomStep(-1)"
        >
          <Minus :size="17" />
        </button>
        <select
          :value="Math.round(zoom * 100)"
          aria-label="白板缩放"
          title="选择缩放比例，100%为原始大小"
          @change="setZoom(Number($event.target.value) / 100)"
        >
          <option v-for="percent in zoomOptions" :key="percent" :value="percent">{{ percent }}%</option>
        </select>
        <button
          type="button"
          class="board-view-button"
          aria-label="放大白板"
          title="放大"
          :disabled="zoom >= MAX_BOARD_SCALE"
          @click="zoomStep(1)"
        >
          <Plus :size="17" />
        </button>
        <span class="board-navigation-divider" aria-hidden="true" />
        <button
          type="button"
          class="board-view-button board-fit-button"
          aria-label="适应全部内容"
          title="将全部卡片和图片放入视野"
          @click="fitContents"
        >
          <Maximize2 :size="17" /><span>适应</span>
        </button>
      </div>
    </div>
  </div>
</template>
