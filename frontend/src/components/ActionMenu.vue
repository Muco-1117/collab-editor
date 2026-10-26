<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue'
import { MoreHorizontal } from 'lucide-vue-next'

const props = defineProps({
  label: { type: String, default: '更多操作' },
  items: { type: Array, required: true },
  align: { type: String, default: 'end' },
})
const emit = defineEmits(['select'])
const trigger = ref(null)
const menu = ref(null)
const opened = ref(false)
const position = ref({})
const menuId = useId()
let openedAnchor = null
const openedScrollPositions = new Map()

function rememberScrollPositions() {
  openedScrollPositions.clear()
  let element = trigger.value
  while (element) {
    openedScrollPositions.set(element, { left: element.scrollLeft, top: element.scrollTop })
    element = element.parentElement
  }
}

function close(restoreFocus = false) {
  opened.value = false
  openedAnchor = null
  openedScrollPositions.clear()
  if (restoreFocus) trigger.value?.focus({ preventScroll: true })
}

async function open(last = false) {
  if (opened.value) return
  const anchor = trigger.value.getBoundingClientRect()
  openedAnchor = anchor
  rememberScrollPositions()
  position.value = {
    left: `${Math.max(8, props.align === 'start' ? anchor.left : anchor.right - 192)}px`,
    top: `${anchor.bottom + 6}px`,
  }
  opened.value = true
  await nextTick()
  if (!menu.value) return
  const rect = menu.value.getBoundingClientRect()
  const preferredLeft = props.align === 'start' ? anchor.left : anchor.right - rect.width
  const left = Math.max(8, Math.min(preferredLeft, window.innerWidth - rect.width - 8))
  const top =
    anchor.bottom + 6 + rect.height <= window.innerHeight - 8
      ? anchor.bottom + 6
      : Math.max(8, anchor.top - rect.height - 6)
  position.value = { left: `${left}px`, top: `${top}px` }
  const buttons = menu.value.querySelectorAll('button:not(:disabled)')
  buttons[last ? buttons.length - 1 : 0]?.focus({ preventScroll: true })
}

function select(item) {
  if (item.disabled) return
  close(true)
  emit('select', item.key)
}

function keydown(event) {
  if (event.key === 'Escape' || event.key === 'Tab') {
    if (event.key === 'Escape') event.preventDefault()
    close(true)
    return
  }
  const buttons = [...menu.value.querySelectorAll('button:not(:disabled)')]
  const index = buttons.indexOf(document.activeElement)
  const targets = {
    ArrowDown: (index + 1) % buttons.length,
    ArrowUp: (index - 1 + buttons.length) % buttons.length,
    Home: 0,
    End: buttons.length - 1,
  }
  if (event.key in targets) {
    event.preventDefault()
    buttons[targets[event.key]]?.focus()
  }
}

function outside(event) {
  if (!trigger.value?.contains(event.target) && !menu.value?.contains(event.target)) close()
}
function dismiss() {
  close()
}
function scrolled(event) {
  if (!opened.value || menu.value?.contains(event.target)) return
  const target = event.target === document ? document.scrollingElement : event.target
  const previous = openedScrollPositions.get(target)
  const anchor = trigger.value?.getBoundingClientRect()
  // A click can scroll its trigger into view before opening, while the scroll
  // event arrives afterward. Ignore it only if neither scroll nor anchor moved.
  if (
    previous &&
    previous.left === target.scrollLeft &&
    previous.top === target.scrollTop &&
    anchor &&
    openedAnchor &&
    anchor.left === openedAnchor.left &&
    anchor.top === openedAnchor.top
  )
    return
  close()
}
onMounted(() => {
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('focusin', outside, true)
  window.addEventListener('resize', dismiss)
  window.addEventListener('scroll', scrolled, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', outside, true)
  document.removeEventListener('focusin', outside, true)
  window.removeEventListener('resize', dismiss)
  window.removeEventListener('scroll', scrolled, true)
})
</script>

<template>
  <button
    ref="trigger"
    class="icon-button subtle action-menu-trigger"
    type="button"
    :aria-label="label"
    :title="label"
    aria-haspopup="menu"
    :aria-expanded="opened"
    :aria-controls="opened ? menuId : undefined"
    @click.stop="opened ? close(true) : open()"
    @pointerdown.stop
    @keydown.down.prevent.stop="open()"
    @keydown.up.prevent.stop="open(true)"
  >
    <MoreHorizontal :size="17" />
  </button>
  <Teleport to="body">
    <div
      v-if="opened"
      :id="menuId"
      ref="menu"
      class="action-menu"
      role="menu"
      :aria-label="label"
      :style="position"
      @keydown.stop="keydown"
      @click.stop
      @pointerdown.stop
    >
      <button
        v-for="item in items"
        :key="item.key"
        type="button"
        role="menuitem"
        tabindex="-1"
        :class="{ danger: item.danger }"
        :disabled="item.disabled"
        @click="select(item)"
      >
        <component :is="item.icon" v-if="item.icon" :size="16" aria-hidden="true" />
        <span>{{ item.label }}</span>
      </button>
    </div>
  </Teleport>
</template>
