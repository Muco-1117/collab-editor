<script setup>
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-vue-next'
import { dismiss, pauseToast, resumeToast, toasts } from '../stores/toast.js'

const icons = { success: CheckCircle2, error: AlertCircle, info: Info }

function focusLeft(toast, event) {
  if (!event.currentTarget.contains(event.relatedTarget)) resumeToast(toast.id, 'focus')
}

function dismissWithFocus(toast, event) {
  const toastElement = event.currentTarget.closest('.toast')
  const focused = toastElement?.contains(document.activeElement)
  const adjacent = toastElement?.nextElementSibling || toastElement?.previousElementSibling
  dismiss(toast.id)
  if (focused) adjacent?.querySelector('button')?.focus()
}
</script>

<template>
  <div class="toast-host" aria-live="polite" aria-atomic="false">
    <div
      v-for="toast in toasts"
      :key="toast.id"
      class="toast"
      :class="`toast-${toast.type}`"
      role="status"
      @pointerenter="pauseToast(toast.id, 'hover')"
      @pointerleave="resumeToast(toast.id, 'hover')"
      @focusin="pauseToast(toast.id, 'focus')"
      @focusout="focusLeft(toast, $event)"
      @keydown.esc.prevent.stop="dismissWithFocus(toast, $event)"
    >
      <component :is="icons[toast.type] || Info" :size="18" aria-hidden="true" />
      <span>{{ toast.message }}</span>
      <button
        class="icon-button subtle"
        type="button"
        aria-label="关闭提示"
        @click="dismissWithFocus(toast, $event)"
      >
        <X :size="16" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.toast {
  grid-template-columns: 20px minmax(0, 1fr) 32px;
}
.toast > span {
  min-width: 0;
  overflow-wrap: anywhere;
  line-height: 1.55;
  white-space: pre-wrap;
}
.toast > svg,
.toast > button {
  align-self: start;
  margin-top: 4px;
}
.toast > button {
  margin-top: 0;
}
.toast-host {
  max-height: calc(100dvh - 32px);
  overflow-y: auto;
  scrollbar-width: thin;
}
@media (max-width: 600px) {
  .toast-host {
    right: 12px;
    bottom: max(12px, env(safe-area-inset-bottom));
    width: calc(100vw - 24px);
    gap: 6px;
  }
  .toast {
    padding: 8px 7px 8px 10px;
    font-size: 12px;
  }
}
</style>

<style>
@media (max-width: 600px) {
  body.modal-open .toast-host {
    top: max(12px, env(safe-area-inset-top));
    bottom: auto;
    max-height: min(28dvh, 180px);
  }
}
</style>
