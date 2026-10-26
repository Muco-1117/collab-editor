<script setup>
import { AlertTriangle } from 'lucide-vue-next'
import BaseModal from './BaseModal.vue'

defineProps({
  title: { type: String, required: true },
  description: { type: String, required: true },
  confirmLabel: { type: String, default: '确认' },
  danger: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
  error: { type: String, default: '' },
})
defineEmits(['cancel', 'confirm'])
</script>

<template>
  <BaseModal :title="title" :close-disabled="busy" @close="!busy && $emit('cancel')">
    <div class="confirm-content">
      <AlertTriangle :size="22" aria-hidden="true" />
      <p>{{ description }}</p>
    </div>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <template #footer>
      <button class="button secondary" type="button" :disabled="busy" @click="$emit('cancel')">取消</button>
      <button
        class="button"
        :class="danger ? 'danger' : 'primary'"
        type="button"
        :disabled="busy"
        @click="$emit('confirm')"
      >
        {{ busy ? '正在处理' : confirmLabel }}
      </button>
    </template>
  </BaseModal>
</template>
