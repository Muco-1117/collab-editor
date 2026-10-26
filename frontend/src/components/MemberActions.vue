<script setup>
import { computed, ref, useId } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import { Pencil, ShieldCheck, UserMinus } from 'lucide-vue-next'
import ActionMenu from './ActionMenu.vue'
import BaseModal from './BaseModal.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import { api } from '../lib/apiClient.js'
import { notify } from '../stores/toast.js'
import { authStore } from '../stores/auth.js'

const props = defineProps({
  member: { type: Object, required: true },
  spaceId: { type: [Number, String], required: true },
})
const emit = defineEmits(['changed'])
const editOpen = ref(false)
const removeOpen = ref(false)
const role = ref('editor')
const busy = ref(false)
const error = ref('')
const formId = useId()
const name = computed(() => props.member.nickname || props.member.username || '成员')
const items = [
  { key: 'role', label: '修改权限', icon: ShieldCheck },
  { key: 'remove', label: '移出空间', icon: UserMinus, danger: true },
]

const canNavigate = () => !busy.value || !authStore.isAuthenticated.value
onBeforeRouteLeave(canNavigate)
onBeforeRouteUpdate(canNavigate)

function select(action) {
  error.value = ''
  if (action === 'role') {
    role.value = props.member.role
    editOpen.value = true
  }
  if (action === 'remove') removeOpen.value = true
}

async function saveRole() {
  if (busy.value || role.value === props.member.role) return
  busy.value = true
  error.value = ''
  try {
    await api(
      `/api/spaces/${encodeURIComponent(props.spaceId)}/members/${encodeURIComponent(props.member.id)}`,
      { method: 'PUT', body: { role: role.value } },
    )
    editOpen.value = false
    emit('changed')
    notify('成员权限已更新', 'success')
  } catch (requestError) {
    error.value = requestError.message
  } finally {
    busy.value = false
  }
}

async function removeMember() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await api(
      `/api/spaces/${encodeURIComponent(props.spaceId)}/members/${encodeURIComponent(props.member.id)}`,
      { method: 'DELETE' },
    )
    removeOpen.value = false
    emit('changed')
    notify('成员已移出空间', 'success')
  } catch (requestError) {
    error.value = requestError.message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <ActionMenu :label="`管理成员：${name}`" :items="items" @select="select" />
  <BaseModal
    v-if="editOpen"
    title="修改成员权限"
    :description="`${name} · @${member.username}`"
    :close-disabled="busy"
    @close="!busy && (editOpen = false)"
  >
    <form :id="formId" class="modal-form" @submit.prevent="saveRole">
      <fieldset :disabled="busy">
        <legend>在当前空间的权限</legend>
        <label class="radio-row"
          ><input v-model="role" type="radio" value="editor" /><span
            ><strong>编辑者</strong><small>可创建、修改内容和恢复历史版本</small></span
          ></label
        >
        <label class="radio-row"
          ><input v-model="role" type="radio" value="viewer" /><span
            ><strong>只读者</strong><small>可查看、搜索与导出，不能修改内容</small></span
          ></label
        >
      </fieldset>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    </form>
    <template #footer>
      <button class="button secondary" type="button" :disabled="busy" @click="editOpen = false">取消</button>
      <button class="button primary" :form="formId" :disabled="busy || role === member.role">
        <Pencil :size="15" />{{ busy ? '正在保存' : '保存权限' }}
      </button>
    </template>
  </BaseModal>
  <ConfirmDialog
    v-if="removeOpen"
    title="移出空间"
    :description="`将“${name}”移出当前空间？对方将无法继续访问这里的文档、白板和看板，已经创建的内容会保留。`"
    confirm-label="移出空间"
    :busy="busy"
    :error="error"
    danger
    @cancel="!busy && (removeOpen = false)"
    @confirm="removeMember"
  />
</template>
