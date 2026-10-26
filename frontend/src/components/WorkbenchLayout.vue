<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { activateFocusLayer } from '../lib/focusLayer.js'

// Adapted from shadcn-vue Sidebar / SidebarInset (MIT).
// Attribution and source links: styles/vendor/shadcn-vue.LICENSE, docs/ui-design.md.
const props = defineProps({ navigationOpen: { type: Boolean, default: false } })
const emit = defineEmits(['close-navigation'])
const sidebar = ref(null)
const mobile = ref(false)
const isTopLayer = ref(false)
const drawerOpen = computed(() => mobile.value && props.navigationOpen)
let mediaQuery = null
let focusLayer = null
let generation = 0

function updateBreakpoint() {
  mobile.value = mediaQuery.matches
  if (!mobile.value && props.navigationOpen) emit('close-navigation')
}

watch(drawerOpen, async (opened) => {
  const request = ++generation
  focusLayer?.release({ restoreFocus: mobile.value })
  focusLayer = null
  if (!opened) return
  // Capture the menu button before the main content becomes inert.
  const returnFocusTo = document.activeElement
  await nextTick()
  if (request !== generation || !drawerOpen.value || !sidebar.value) return
  focusLayer = activateFocusLayer(sidebar.value, {
    returnFocusTo,
    onEscape: () => emit('close-navigation'),
    onTopChange: (active) => {
      isTopLayer.value = active
    },
  })
})

onMounted(() => {
  mediaQuery = window.matchMedia('(max-width: 820px)')
  updateBreakpoint()
  mediaQuery.addEventListener('change', updateBreakpoint)
})

onBeforeUnmount(() => {
  generation += 1
  mediaQuery?.removeEventListener('change', updateBreakpoint)
  focusLayer?.release({ restoreFocus: false })
})
</script>

<template>
  <div class="app-layout dashboard-shell">
    <div v-if="drawerOpen" class="mobile-overlay" aria-hidden="true" @click="$emit('close-navigation')" />
    <aside
      ref="sidebar"
      class="app-sidebar"
      :class="{ open: drawerOpen }"
      :inert="mobile && (!drawerOpen || !isTopLayer)"
      :role="drawerOpen ? 'dialog' : undefined"
      :aria-modal="drawerOpen && isTopLayer ? true : undefined"
      aria-label="工作台导航"
      tabindex="-1"
    >
      <slot name="sidebar" />
    </aside>
    <main class="app-main" :inert="drawerOpen"><slot /></main>
  </div>
</template>
