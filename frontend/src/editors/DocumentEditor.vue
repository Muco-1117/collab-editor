<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, useId, watch } from 'vue'
import { AlignLeft, ChevronDown, ChevronUp, Plus, Search, Trash2, X } from 'lucide-vue-next'
import { fieldValue } from '../collab/collabState.js'
import { elementPatch } from '../collab/elementValues.js'
import { compareElementOrder } from '../collab/ordering.js'
import { planInsertionOrder } from '../collab/insertionOrder.js'
import { findDocumentMatches, MAX_FIND_QUERY_LENGTH, retainMatchIndex } from '../lib/documentSearch.js'
import AssetImage from '../components/AssetImage.vue'
import ImageUpload from '../components/ImageUpload.vue'

const props = defineProps({ collab: { type: Object, required: true } })
const editor = ref(null)
const compositionDrafts = reactive({})
const findOpen = ref(false)
const findQuery = ref('')
const findInput = ref(null)
const findButton = ref(null)
const findComposing = ref(false)
const currentMatchIndex = ref(-1)
const findStatusId = useId()
let previousFocus = null
let revealGeneration = 0

const paragraphs = computed(() => {
  props.collab.stateVersion.value
  return [...props.collab.state.elements.values()]
    .filter((element) => ['TEXT', 'IMAGE'].includes(element.type))
    .sort((left, right) => compareElementOrder(left, right))
})

const matches = computed(() => (findOpen.value ? findDocumentMatches(paragraphs.value, findQuery.value) : []))
const currentMatch = computed(() => matches.value[currentMatchIndex.value] || null)
const findStatus = computed(() => {
  if (!findQuery.value) return '输入关键词'
  return matches.value.length ? `${currentMatchIndex.value + 1} / ${matches.value.length}` : '0 处匹配'
})
const findAnnouncement = computed(() =>
  matches.value.length
    ? `第 ${currentMatchIndex.value + 1} 处，共 ${matches.value.length} 处匹配`
    : findStatus.value,
)

async function revealMatch() {
  const generation = ++revealGeneration
  const match = currentMatch.value
  if (!match) return
  await nextTick()
  if (generation !== revealGeneration || !findOpen.value || currentMatch.value !== match) return
  const textarea = editor.value?.querySelector(`[data-paragraph-id="${CSS.escape(match.id)}"]`)
  if (!textarea) return
  textarea.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' })
  if (!Object.hasOwn(compositionDrafts, match.id)) textarea.setSelectionRange(match.start, match.end)
}

async function openFind() {
  if (!findOpen.value) {
    const target = document.activeElement
    previousFocus = {
      target,
      start: target?.selectionStart,
      end: target?.selectionEnd,
      direction: target?.selectionDirection,
    }
  }
  findOpen.value = true
  await nextTick()
  findInput.value?.focus({ preventScroll: true })
  findInput.value?.select()
  revealMatch()
}

async function closeFind() {
  findOpen.value = false
  findComposing.value = false
  revealGeneration += 1
  await nextTick()
  const target = previousFocus?.target
  if (target?.isConnected && target !== document.body && !target.closest('[inert]') && !target.disabled) {
    target.focus({ preventScroll: true })
    if (typeof previousFocus.start === 'number') {
      target.setSelectionRange(previousFocus.start, previousFocus.end, previousFocus.direction)
      target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' })
    }
  } else findButton.value?.focus({ preventScroll: true })
  previousFocus = null
}

function nextMatch(direction) {
  if (!matches.value.length) return
  currentMatchIndex.value =
    (currentMatchIndex.value + direction + matches.value.length) % matches.value.length
  revealMatch()
}

function findKeydown(event) {
  if (event.isComposing || event.keyCode === 229 || findComposing.value) return
  if (event.key === 'Enter') {
    event.preventDefault()
    nextMatch(event.shiftKey ? -1 : 1)
  }
}

function handleFindShortcut(event) {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || findComposing.value) return
  if (!editor.value?.isConnected || document.body.classList.contains('modal-open')) return
  if (event.target?.closest?.('[role="dialog"], [inert]')) return
  if (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === 'f'
  ) {
    event.preventDefault()
    openFind()
  } else if (event.key === 'Escape' && findOpen.value) {
    event.preventDefault()
    closeFind()
  }
}

watch(
  () => ({ query: findQuery.value, results: matches.value }),
  (next, previous) => {
    const queryChanged = next.query !== previous?.query
    const active = previous?.results[currentMatchIndex.value]
    currentMatchIndex.value = queryChanged
      ? next.results.length
        ? 0
        : -1
      : retainMatchIndex(next.results, active, currentMatchIndex.value)
    // Background collaboration updates refresh the count without moving the
    // user's focus or viewport. Only their search action scrolls the document.
    if (queryChanged && findOpen.value) revealMatch()
  },
)

onMounted(() => document.addEventListener('keydown', handleFindShortcut))
onBeforeUnmount(() => {
  revealGeneration += 1
  document.removeEventListener('keydown', handleFindShortcut)
})

function newId() {
  return `text-${crypto.randomUUID()}`
}

function insertionOrder(elements, index) {
  const plan = planInsertionOrder(elements, index)
  for (const update of plan.updates) {
    if (!updateElement(update.id, update.type, { order: update.order })) return null
  }
  return plan.order
}

function createParagraph(index, text) {
  if (!props.collab.canEdit.value) return
  const id = newId()
  const order = insertionOrder(paragraphs.value, index)
  if (order === null) return
  if (!props.collab.setElement(id, 'TEXT', { order, text })) return
  return id
}

function updateElement(id, type, changes) {
  if (!props.collab.canEdit.value) return false
  const values = elementPatch(props.collab.state, id, type, changes)
  return values !== null && props.collab.setElement(id, type, values)
}

async function focusParagraph(id, position = null) {
  await nextTick()
  const textarea = editor.value?.querySelector(`[data-paragraph-id="${CSS.escape(id)}"]`)
  if (!textarea || !props.collab.canEdit.value) return
  textarea.focus()
  if (position !== null) textarea.setSelectionRange(position, position)
}

async function addParagraph(index = paragraphs.value.length, text = '') {
  const id = createParagraph(index, text)
  if (id) await focusParagraph(id)
}

function updateText(paragraph, event) {
  const text = event.target.value
  if (event.isComposing || Object.hasOwn(compositionDrafts, paragraph.id)) {
    compositionDrafts[paragraph.id] = text
  } else if (fieldValue(props.collab.state.elements.get(paragraph.id), 'text', '') !== text) {
    updateElement(paragraph.id, 'TEXT', { text })
  }
  resize(event.target)
}

function paragraphText(paragraph) {
  return Object.hasOwn(compositionDrafts, paragraph.id)
    ? compositionDrafts[paragraph.id]
    : fieldValue(paragraph, 'text', '')
}

function finishComposition(paragraph, event) {
  delete compositionDrafts[paragraph.id]
  updateText(paragraph, event)
}

function isComposing(paragraph, event) {
  return event.isComposing || event.keyCode === 229 || Object.hasOwn(compositionDrafts, paragraph.id)
}

function resize(textarea) {
  if (!textarea) return
  textarea.style.height = 'auto'
  const border = textarea.offsetHeight - textarea.clientHeight
  textarea.style.height = `${Math.max(42, textarea.scrollHeight + border)}px`
}

const resizeObservers = new WeakMap()
const vAutosize = {
  mounted(textarea) {
    resize(textarea)
    let lastWidth = null
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width
      if (width === lastWidth) return
      lastWidth = width
      resize(textarea)
    })
    observer.observe(textarea)
    resizeObservers.set(textarea, observer)
  },
  updated: resize,
  beforeUnmount(textarea) {
    resizeObservers.get(textarea)?.disconnect()
    resizeObservers.delete(textarea)
  },
}

async function splitParagraph(paragraph, index, event) {
  if (!props.collab.canEdit.value || event.shiftKey || isComposing(paragraph, event)) return
  if (!props.collab.state.elements.has(paragraph.id)) return
  event.preventDefault()
  const textarea = event.currentTarget
  const text = textarea.value
  const cursor = textarea.selectionStart
  const id = createParagraph(index + 1, text.slice(textarea.selectionEnd))
  if (!id) return
  if (!updateElement(paragraph.id, 'TEXT', { text: text.slice(0, cursor) })) return
  await focusParagraph(id, 0)
}

async function removeParagraph(paragraph, index) {
  if (!props.collab.canEdit.value) return
  if (!props.collab.state.elements.has(paragraph.id)) return
  if (!props.collab.deleteElement(paragraph.id, paragraph.type)) return
  delete compositionDrafts[paragraph.id]
  await nextTick()
  const before = paragraphs.value.slice(0, index).filter((item) => item.type === 'TEXT')
  const target = before.at(-1) || paragraphs.value.find((item) => item.type === 'TEXT')
  if (target) await focusParagraph(target.id, String(fieldValue(target, 'text', '')).length)
}

function handleBackspace(paragraph, index, event) {
  if (!props.collab.canEdit.value || isComposing(paragraph, event)) return
  if (event.currentTarget.value === '' && paragraphs.value.length > 1) {
    event.preventDefault()
    removeParagraph(paragraph, index)
  }
}

function moveParagraph(paragraph, index, direction) {
  if (!props.collab.canEdit.value) return
  const targetIndex = index + direction
  if (targetIndex < 0 || targetIndex >= paragraphs.value.length) return
  const others = paragraphs.value.filter((item) => item.id !== paragraph.id)
  const order = insertionOrder(others, targetIndex)
  if (order !== null) updateElement(paragraph.id, paragraph.type, { order })
}

function insertImage(asset, existing = null) {
  if (!props.collab.canEdit.value) return
  if (existing) updateElement(existing.id, 'IMAGE', asset)
  else {
    const order = insertionOrder(paragraphs.value, paragraphs.value.length)
    if (order !== null) props.collab.setElement(`image-${crypto.randomUUID()}`, 'IMAGE', { ...asset, order })
  }
}

watch(
  () => [props.collab.canEdit.value, props.collab.stateVersion.value],
  () => {
    for (const id of Object.keys(compositionDrafts)) {
      if (!props.collab.canEdit.value || !props.collab.state.elements.has(id)) delete compositionDrafts[id]
    }
  },
  { flush: 'sync' },
)
</script>

<template>
  <section ref="editor" class="document-editor-shell" aria-label="文档编辑器">
    <div class="document-tools">
      <div v-if="findOpen" class="document-find" role="search" aria-label="文档内查找">
        <label class="document-find-field">
          <Search :size="15" aria-hidden="true" />
          <input
            ref="findInput"
            v-model="findQuery"
            type="search"
            aria-label="查找正文"
            :aria-describedby="findStatusId"
            :maxlength="MAX_FIND_QUERY_LENGTH"
            placeholder="查找文档内容"
            title="按字面查找，最多 128 字符"
            autocomplete="off"
            @keydown="findKeydown"
            @compositionstart="findComposing = true"
            @compositionend="findComposing = false"
          />
        </label>
        <div class="document-find-controls">
          <span
            :id="findStatusId"
            class="document-find-count"
            role="status"
            aria-live="polite"
            :aria-label="findAnnouncement"
            >{{ findStatus }}</span
          >
          <button
            class="icon-button subtle"
            type="button"
            aria-label="上一处"
            title="上一处（Shift+Enter）"
            :disabled="!matches.length"
            @click="nextMatch(-1)"
          >
            <ChevronUp :size="16" />
          </button>
          <button
            class="icon-button subtle"
            type="button"
            aria-label="下一处"
            title="下一处（Enter）"
            :disabled="!matches.length"
            @click="nextMatch(1)"
          >
            <ChevronDown :size="16" />
          </button>
          <button
            class="icon-button subtle"
            type="button"
            aria-label="关闭查找"
            title="关闭查找（Esc）"
            @click="closeFind"
          >
            <X :size="16" />
          </button>
        </div>
      </div>
      <button
        v-else
        ref="findButton"
        class="button document-find-trigger"
        type="button"
        aria-label="查找正文"
        title="查找正文（Ctrl / ⌘ + F）"
        @click="openFind"
      >
        <Search :size="15" />查找
      </button>
    </div>
    <div class="document-editor">
      <div class="document-page" :class="{ 'document-page-empty': !paragraphs.length }">
        <div v-if="!paragraphs.length" class="editor-empty">
          <AlignLeft :size="26" />
          <p>{{ collab.canEdit.value ? '从第一个段落开始' : '文档还没有内容' }}</p>
        </div>
        <div v-else class="paragraph-list">
          <div
            v-for="(paragraph, index) in paragraphs"
            :key="paragraph.id"
            class="paragraph-row"
            :class="{ 'paragraph-find-current': currentMatch?.id === paragraph.id }"
          >
            <div class="paragraph-controls">
              <span aria-hidden="true">{{ index + 1 }}</span>
              <template v-if="collab.canEdit.value">
                <button
                  type="button"
                  aria-label="段落上移"
                  title="段落上移"
                  :disabled="index === 0"
                  @click="moveParagraph(paragraph, index, -1)"
                >
                  <ChevronUp :size="14" />
                </button>
                <button
                  type="button"
                  aria-label="段落下移"
                  title="段落下移"
                  :disabled="index === paragraphs.length - 1"
                  @click="moveParagraph(paragraph, index, 1)"
                >
                  <ChevronDown :size="14" />
                </button>
              </template>
            </div>
            <figure v-if="paragraph.type === 'IMAGE'" class="document-image" :data-image-id="paragraph.id">
              <AssetImage
                :asset-id="fieldValue(paragraph, 'assetId', '')"
                :alt="fieldValue(paragraph, 'name', '文档图片')"
              />
              <figcaption>{{ fieldValue(paragraph, 'name', '') }}</figcaption>
              <ImageUpload
                v-if="collab.canEdit.value"
                :doc-id="collab.docId"
                label="替换图片"
                :disabled="!collab.canEdit.value"
                @uploaded="insertImage($event, paragraph)"
              />
            </figure>
            <textarea
              v-else
              v-autosize
              :data-paragraph-id="paragraph.id"
              :value="paragraphText(paragraph)"
              :readonly="!collab.canEdit.value"
              rows="1"
              :aria-label="`第 ${index + 1} 段`"
              placeholder="输入段落内容"
              @focus="resize($event.currentTarget)"
              @input="updateText(paragraph, $event)"
              @compositionstart="compositionDrafts[paragraph.id] = $event.target.value"
              @compositionend="finishComposition(paragraph, $event)"
              @keydown.enter="splitParagraph(paragraph, index, $event)"
              @keydown.backspace="handleBackspace(paragraph, index, $event)"
            />
            <button
              v-if="collab.canEdit.value"
              class="icon-button paragraph-delete danger-on-hover"
              type="button"
              :aria-label="paragraph.type === 'IMAGE' ? '删除图片' : `删除第 ${index + 1} 段`"
              title="删除内容"
              @click="removeParagraph(paragraph, index)"
            >
              <Trash2 :size="16" />
            </button>
          </div>
        </div>
        <div v-if="collab.canEdit.value" class="document-insert-actions" role="group" aria-label="插入内容">
          <button class="button secondary" type="button" @click="addParagraph()">
            <Plus :size="16" />添加段落
          </button>
          <ImageUpload :doc-id="collab.docId" @uploaded="insertImage($event)" />
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.document-editor-shell {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}
.document-tools {
  display: flex;
  justify-content: flex-end;
  flex: 0 0 auto;
  min-height: 43px;
  padding: 5px 18px;
  border-bottom: 1px solid #e9ebef;
  background: #fff;
}
.document-find-trigger {
  min-height: 32px;
  padding: 5px 9px;
  color: #707989;
  background: transparent;
  font-size: 12px;
  font-weight: 500;
}
.document-find-trigger:hover {
  color: #4263eb;
  background: #f0f3ff;
}
.document-find {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  min-width: 0;
  width: min(100%, 540px);
}
.document-find-field {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  padding: 0 9px;
  border: 1px solid #e1e5ef;
  border-radius: 5px;
  color: #707989;
  background: #f7f8fa;
}
.document-find-field:focus-within {
  border-color: #4263eb;
  box-shadow: 0 0 0 2px #4263eb12;
}
.document-find-field > svg {
  flex-shrink: 0;
}
.document-find-field input {
  min-width: 0;
  height: 31px;
  padding: 4px 0;
  border: 0;
  border-radius: 0;
  color: #252a34;
  background: transparent;
  box-shadow: none;
  outline: 0;
  font-size: 12px;
}
.document-find-controls {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}
.document-find-count {
  min-width: 58px;
  margin-right: 5px;
  color: #707989;
  font-size: 11px;
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.document-find-controls .icon-button {
  width: 30px;
  height: 30px;
  flex-basis: 30px;
}
.workspace-layout .paragraph-row.paragraph-find-current {
  background: #eef2ff;
  box-shadow: -3px 0 #4263eb;
}
@media (max-width: 520px) {
  .document-tools {
    padding: 5px 12px;
  }
  .document-find {
    flex-wrap: wrap;
    gap: 4px;
  }
  .document-find-field {
    flex-basis: 100%;
  }
  .document-find-controls {
    margin-left: auto;
  }
}
</style>
