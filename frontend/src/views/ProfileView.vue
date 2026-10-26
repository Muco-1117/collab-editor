<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { ArrowLeft, Camera, Check, LoaderCircle, LockKeyhole, UserRound } from 'lucide-vue-next'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import UserAvatar from '../components/UserAvatar.vue'
import { authStore } from '../stores/auth.js'
import { notify } from '../stores/toast.js'
import { readWorkbenchReturn } from '../lib/workbenchNavigation.js'

const returnTo = readWorkbenchReturn(authStore.state.user?.id)
const nickname = ref(authStore.state.user?.nickname || '')
const savingName = ref(false)
const savingAvatar = ref(false)
const loadingProfile = ref(true)
const fileInput = ref(null)
const changed = computed(() => nickname.value.trim() !== (authStore.state.user?.nickname || ''))
const avatarUrl = computed(() => authStore.state.user?.avatarUrl || '')
const busy = computed(() => loadingProfile.value || savingName.value || savingAvatar.value)
const displayName = computed(() => authStore.displayName.value)
const formError = ref('')
const pendingLeave = ref(false)
let resolveLeave = null

function cancelNickname() {
  nickname.value = authStore.state.user?.nickname || ''
  formError.value = ''
}

function finishLeave(leave) {
  pendingLeave.value = false
  const resolve = resolveLeave
  resolveLeave = null
  resolve?.(leave)
}

onBeforeRouteLeave(() => {
  // 登录失效时仍须允许跳转到登录页，不能被保存状态拦住。
  if (!authStore.isAuthenticated.value) return true
  if (savingName.value || savingAvatar.value) {
    notify('正在保存，请稍候再离开', 'info')
    return false
  }
  if (!changed.value) return true
  if (resolveLeave) return false
  pendingLeave.value = true
  return new Promise((resolve) => {
    resolveLeave = resolve
  })
})

function beforeUnload(event) {
  if (!changed.value && !savingName.value && !savingAvatar.value) return
  event.preventDefault()
  event.returnValue = ''
}

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', beforeUnload)
  finishLeave(false)
})

onMounted(async () => {
  window.addEventListener('beforeunload', beforeUnload)
  const previousNickname = nickname.value
  try {
    await authStore.loadMe()
    // 保留用户在资料刷新期间已经输入的昵称。
    if (nickname.value === previousNickname) nickname.value = authStore.state.user?.nickname || ''
  } catch (error) {
    notify(error.message, 'error')
  } finally {
    loadingProfile.value = false
  }
})

async function saveNickname() {
  if (busy.value) return
  const name = nickname.value.trim()
  if (!name || name.length > 32) {
    formError.value = '请输入 1–32 字的昵称'
    return
  }
  savingName.value = true
  formError.value = ''
  try {
    await authStore.updateProfile(name)
    nickname.value = authStore.state.user.nickname
    notify('昵称已更新', 'success')
  } catch (error) {
    formError.value = error.message
  } finally {
    savingName.value = false
  }
}

async function uploadAvatar(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file || busy.value) return
  if (!['image/png', 'image/jpeg'].includes(file.type)) return notify('头像仅支持 PNG、JPEG 图片', 'error')
  if (file.size > 2 * 1024 * 1024) return notify('头像大小不能超过 2MB', 'error')
  savingAvatar.value = true
  try {
    await authStore.updateAvatar(file)
    notify('头像已更新', 'success')
  } catch (error) {
    notify(error.message, 'error')
  } finally {
    savingAvatar.value = false
  }
}

async function removeAvatar() {
  if (busy.value) return
  savingAvatar.value = true
  try {
    await authStore.removeAvatar()
    notify('已恢复默认头像', 'success')
  } catch (error) {
    notify(error.message, 'error')
  } finally {
    savingAvatar.value = false
  }
}
</script>

<template>
  <div class="profile-page">
    <header class="profile-topbar">
      <RouterLink class="profile-back" :to="returnTo"><ArrowLeft :size="17" />返回工作台</RouterLink>
      <span class="profile-breadcrumb">个人主页</span>
      <span class="profile-topbar-account" :title="displayName">{{ displayName }}</span>
    </header>
    <main class="profile-content">
      <div class="profile-heading">
        <span class="profile-heading-icon"><UserRound :size="23" /></span>
        <div>
          <h1>个人主页</h1>
          <p>让协作伙伴更容易认出你</p>
        </div>
      </div>
      <section class="profile-panel" aria-labelledby="profile-avatar-heading">
        <div class="profile-section-label">
          <h2 id="profile-avatar-heading">个人头像</h2>
          <p>展示在工作台和成员列表中</p>
        </div>
        <div class="profile-avatar-settings" :aria-busy="savingAvatar">
          <UserAvatar class="profile-avatar" :name="authStore.displayName.value" :source="avatarUrl" />
          <div class="profile-avatar-controls">
            <div class="profile-avatar-buttons">
              <button class="button secondary" type="button" :disabled="busy" @click="fileInput?.click()">
                <LoaderCircle v-if="savingAvatar" class="spin" :size="16" /><Camera v-else :size="16" />{{
                  savingAvatar ? '正在更新' : '更换头像'
                }}
              </button>
              <button
                v-if="avatarUrl"
                class="profile-text-button"
                type="button"
                :disabled="busy"
                @click="removeAvatar"
              >
                恢复默认
              </button>
            </div>
            <p>支持 PNG、JPEG，最大 2MB。图片将居中裁剪为正方形。</p>
            <input
              ref="fileInput"
              type="file"
              accept="image/png,image/jpeg"
              hidden
              aria-label="选择头像图片"
              @change="uploadAvatar"
            />
          </div>
        </div>
      </section>
      <section class="profile-panel" aria-labelledby="profile-info-heading">
        <div class="profile-section-label">
          <h2 id="profile-info-heading">个人资料</h2>
          <p>设置你在工作台中的显示名称</p>
        </div>
        <form class="profile-form" :aria-busy="savingName" @submit.prevent="saveNickname">
          <div class="profile-label-row">
            <label for="profile-username">登录用户名</label><span><LockKeyhole :size="12" />不可修改</span>
          </div>
          <input
            id="profile-username"
            :value="authStore.state.user?.username || ''"
            readonly
            aria-describedby="profile-username-hint"
          />
          <p id="profile-username-hint" class="profile-field-hint">用于登录账号和邀请成员。</p>
          <div class="profile-label-row">
            <label for="profile-nickname">昵称</label
            ><span class="profile-character-count" aria-hidden="true">{{ nickname.length }} / 32</span>
          </div>
          <input
            id="profile-nickname"
            v-model="nickname"
            maxlength="32"
            required
            autocomplete="nickname"
            :disabled="busy"
            :aria-invalid="Boolean(formError)"
            :aria-describedby="formError ? 'profile-name-error' : 'profile-name-hint'"
            @input="formError = ''"
          />
          <p id="profile-name-hint" class="profile-field-hint">1–32 字，协作时将显示这个名字。</p>
          <p v-if="formError" id="profile-name-error" class="profile-form-error" role="alert">
            {{ formError }}
          </p>
          <div class="profile-save-row">
            <span class="profile-save-status" :class="{ pending: changed }" role="status"
              ><span v-if="changed" class="profile-pending-dot" />{{
                loadingProfile
                  ? '正在加载资料'
                  : savingName
                    ? '正在保存修改'
                    : savingAvatar
                      ? '正在更新头像'
                      : changed
                        ? '昵称尚未保存'
                        : '资料已保存'
              }}</span
            >
            <div class="profile-save-actions">
              <button
                v-if="changed"
                class="button secondary"
                type="button"
                :disabled="busy"
                @click="cancelNickname"
              >
                取消修改
              </button>
              <button class="button primary" type="submit" :disabled="busy || !changed || !nickname.trim()">
                <LoaderCircle v-if="savingName" class="spin" :size="16" /><Check v-else :size="16" />{{
                  savingName ? '正在保存' : '保存昵称'
                }}
              </button>
            </div>
          </div>
        </form>
      </section>
    </main>
    <ConfirmDialog
      v-if="pendingLeave"
      title="昵称还没有保存"
      description="离开后，本次输入的昵称不会保留。"
      confirm-label="放弃修改并离开"
      @cancel="finishLeave(false)"
      @confirm="finishLeave(true)"
    />
  </div>
</template>

<style scoped>
:global(body:has(.profile-page) .modal-backdrop) {
  --green: #4263eb;
  --green-dark: #344fc4;
  --green-soft: #eef2ff;
  --line: #e9ebef;
  --ink: #343d4f;
}
.profile-page {
  --ink: #252a34;
  --muted: #707989;
  --line: #e9ebef;
  --line-strong: #dce0e6;
  --surface-soft: #f7f8fa;
  --green: #4263eb;
  --green-dark: #344fc4;
  --green-soft: #eef2ff;
  background: #f7f8fa;
  color: var(--ink);
  font-family: 'Segoe UI', 'Microsoft YaHei UI', 'Microsoft YaHei', system-ui, sans-serif;
}
.profile-topbar {
  height: 64px;
  font-size: 13px;
}
.profile-back {
  gap: 9px;
  padding: 7px 0;
}
.profile-back:focus-visible {
  outline: 2px solid var(--green);
  outline-offset: 4px;
  border-radius: 4px;
}
.profile-topbar > .profile-topbar-account {
  min-width: 0;
  max-width: 220px;
  overflow: hidden;
  margin-left: auto;
  padding: 0;
  border: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.profile-content {
  max-width: 960px;
  padding: 48px 36px 72px;
}
.profile-heading {
  gap: 14px;
  margin-bottom: 30px;
}
.profile-heading-icon {
  background: #edf0f9;
  color: #5d70bd;
}
.profile-heading h1 {
  font-size: 26px;
  line-height: 1.3;
  letter-spacing: -0.5px;
}
.profile-heading p {
  margin-top: 6px;
  font-size: 13px;
}
.profile-panel {
  grid-template-columns: 176px minmax(0, 1fr);
  gap: 32px;
  padding: 30px 32px;
  border-radius: 10px;
}
.profile-panel + .profile-panel {
  margin-top: 20px;
}
.profile-section-label h2 {
  margin: 0 0 9px;
  font-size: 14px;
}
.profile-section-label p {
  max-width: 160px;
}
.profile-avatar {
  color: #4a5ca5;
  background: #e9edfb;
}
.profile-avatar-controls p {
  max-width: 300px;
}
.profile-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 9px;
}
.profile-label-row label {
  color: #384151;
  font-size: 13px;
  font-weight: 600;
}
.profile-label-row > span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: #87909e;
  font-size: 11px;
}
.profile-label-row > .profile-character-count {
  font-variant-numeric: tabular-nums;
}
.profile-form input {
  min-height: 42px;
  border-radius: 7px;
}
.profile-form input[readonly] {
  color: #78808c;
  background: #f7f8fa;
}
.profile-form input:focus {
  border-color: #8396ed;
  box-shadow: 0 0 0 3px #4263eb14;
}
.profile-form input[aria-invalid='true'] {
  border-color: #c66a64;
}
.profile-field-hint {
  margin-bottom: 26px;
}
.profile-save-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 14px;
  padding-top: 20px;
}
.profile-save-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #88909d;
  font-size: 11px;
}
.profile-save-status.pending {
  color: #9b701d;
}
.profile-pending-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #bd8b2c;
}
.profile-save-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-left: auto;
}
.profile-panel .button {
  min-height: 36px;
  border-radius: 6px;
}
.profile-panel .button.secondary {
  color: #535d6e;
}
.profile-text-button {
  border-radius: 4px;
}
@media (max-width: 700px) {
  .profile-content {
    padding: 30px 20px 48px;
  }
  .profile-panel {
    grid-template-columns: minmax(0, 1fr);
    gap: 22px;
    padding: 24px;
  }
  .profile-section-label p {
    max-width: none;
  }
  .profile-topbar-account {
    display: none !important;
  }
}
@media (max-width: 420px) {
  .profile-topbar {
    gap: 14px;
    padding: 0 18px;
  }
  .profile-topbar > .profile-breadcrumb {
    padding-left: 14px;
  }
  .profile-content {
    padding: 28px 16px 40px;
  }
  .profile-panel {
    padding: 22px 18px;
  }
  .profile-heading h1 {
    font-size: 24px;
  }
  .profile-avatar-settings {
    align-items: flex-start;
  }
  .profile-avatar {
    width: 64px;
    height: 64px;
    font-size: 26px;
  }
  .profile-avatar-buttons {
    gap: 6px 12px;
  }
  .profile-panel .button {
    min-height: 40px;
  }
}
</style>
