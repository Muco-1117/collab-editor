<script setup>
import { onBeforeUnmount, onMounted, ref, useId } from 'vue'
import { X } from 'lucide-vue-next'
import { activateFocusLayer } from '../lib/focusLayer.js'

const props = defineProps({
  title: { type: String, required: true },
  description: { type: String, default: '' },
  wide: { type: Boolean, default: false },
  closeLabel: { type: String, default: '关闭' },
  closeDisabled: { type: Boolean, default: false },
})
const emit = defineEmits(['close'])
const titleId = useId()
const descriptionId = useId()
const modal = ref(null)
const isTopLayer = ref(true)
let focusLayer = null

function close() {
  if (!props.closeDisabled && focusLayer?.isTop()) emit('close')
}

onMounted(() => {
  focusLayer = activateFocusLayer(modal.value, {
    onEscape: close,
    onTopChange: (active) => {
      isTopLayer.value = active
    },
  })
})
onBeforeUnmount(() => {
  focusLayer?.release()
})
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop" :inert="!isTopLayer" @mousedown.self="close">
      <section
        ref="modal"
        class="modal"
        :class="{ 'modal-wide': wide }"
        role="dialog"
        :aria-modal="isTopLayer ? true : undefined"
        :aria-labelledby="titleId"
        :aria-describedby="description ? descriptionId : undefined"
        tabindex="-1"
      >
        <header class="modal-header">
          <div>
            <h2 :id="titleId">{{ title }}</h2>
            <p v-if="description" :id="descriptionId">{{ description }}</p>
          </div>
          <button
            class="icon-button"
            type="button"
            :aria-label="closeLabel"
            :disabled="closeDisabled"
            @click="close"
          >
            <X :size="19" />
          </button>
        </header>
        <div class="modal-body"><slot /></div>
        <footer v-if="$slots.footer" class="modal-footer"><slot name="footer" /></footer>
      </section>
    </div>
  </Teleport>
</template>
