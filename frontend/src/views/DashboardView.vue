<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'
import {
  ArrowDownUp,
  ArrowUpRight,
  ChartNoAxesCombined,
  ChevronRight,
  FileText,
  FolderKanban,
  Home,
  LayoutDashboard,
  LogOut,
  Menu,
  PanelTop,
  Plus,
  RotateCw,
  Search,
  TriangleAlert,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-vue-next'
import BaseModal from '../components/BaseModal.vue'
import ContentSearch from '../components/ContentSearch.vue'
import ContentLibrary from '../components/ContentLibrary.vue'
import DocumentList from '../components/DocumentList.vue'
import MemberActions from '../components/MemberActions.vue'
import RecentWork from '../components/RecentWork.vue'
import StatsPanel from '../components/StatsPanel.vue'
import TrashPanel from '../components/TrashPanel.vue'
import UserAvatar from '../components/UserAvatar.vue'
import WorkbenchLayout from '../components/WorkbenchLayout.vue'
import '../styles/dashboard.css'
import { api } from '../lib/apiClient.js'
import { createLatestRequestGate } from '../lib/requestGate.js'
import { readDashboardPreferences, saveDashboardPreferences } from '../lib/dashboardPreferences.js'
import { rememberWorkbenchLocation, workbenchRoute } from '../lib/workbenchNavigation.js'
import { readRecentWork, recentVisibleWork } from '../lib/recentWork.js'
import { authStore } from '../stores/auth.js'
import { notify } from '../stores/toast.js'

const router = useRouter()
const route = useRoute()
const userId = authStore.state.user?.id
const preferences = readDashboardPreferences(userId)
const spaces = ref([])
const documents = ref([])
const previewVersion = ref(0)
const members = ref([])
const stats = ref(null)
const activeSpaceId = ref(null)
const activeSection = computed(() => route.meta.dashboardSection || 'content')
const libraryKind = computed(() => (activeSection.value === 'library' ? route.params.kind : null))
const libraryQuery = ref('')
const sortOrder = ref(preferences.sort)
const recentRecords = ref(readRecentWork(userId))
const loading = reactive({ spaces: true, documents: true, members: true, stats: true })
const errors = reactive({ spaces: '', documents: '', members: '', stats: '' })
let contentSpaceId = ''
const sidebarOpen = ref(false)
const showSpaceModal = ref(false)
const showCreateModal = ref(false)
const showInviteModal = ref(false)
const submitting = ref(false)
const spaceName = ref('')
const createForm = reactive({ kind: 'doc', title: '' })
const inviteForm = reactive({ username: '', role: 'editor' })
const spaceListRequests = createLatestRequestGate()
const spaceContentRequests = createLatestRequestGate()
const statsRequests = createLatestRequestGate()
const refreshing = ref(false)
let lastRefreshAt = 0

const kindMeta = {
  doc: {
    name: '文档',
    title: '新建文档',
    description: '记录想法，沉淀团队知识',
    placeholder: '例如：项目说明',
    icon: FileText,
    libraryDescription: '把项目说明、会议记录与团队知识整理在一起。',
  },
  board: {
    name: '白板',
    title: '新建白板',
    description: '自由构思，让思路连成一片',
    placeholder: '例如：需求梳理',
    icon: PanelTop,
    libraryDescription: '浏览画布上的想法，继续上一次的构思。',
  },
  kanban: {
    name: '看板',
    title: '新建看板',
    description: '拆解任务，推动每一步进展',
    placeholder: '例如：迭代计划',
    icon: LayoutDashboard,
    libraryDescription: '先看任务分布，再进入看板推进协作。',
  },
}
const roleNames = { owner: '所有者', editor: '编辑者', viewer: '只读者', admin: '所有者' }
const sectionName = computed(() =>
  activeSection.value === 'members'
    ? '空间成员'
    : activeSection.value === 'stats'
      ? '协同统计'
      : activeSection.value === 'trash'
        ? '回收站'
        : kindMeta[libraryKind.value]?.name || '空间首页',
)
const libraryMeta = computed(() => kindMeta[libraryKind.value] || null)
const activeSpace = computed(
  () => spaces.value.find((space) => Number(space.id) === Number(activeSpaceId.value)) || null,
)
const activeRole = computed(() => activeSpace.value?.my_role || activeSpace.value?.myRole || 'viewer')
const canWrite = computed(() => ['owner', 'admin', 'editor'].includes(activeRole.value))
const isOwner = computed(() => ['owner', 'admin'].includes(activeRole.value))
const filteredDocuments = computed(() => {
  const rows = documents.value.filter((document) => (document.kind || 'doc') === libraryKind.value)
  return rows.sort((a, b) =>
    sortOrder.value === 'title'
      ? (a.title || '').localeCompare(b.title || '', 'zh-CN', { numeric: true })
      : new Date(b.updated_at || b.updatedAt || b.created_at || 0) -
        new Date(a.updated_at || a.updatedAt || a.created_at || 0),
  )
})
const recentDocuments = computed(() =>
  recentVisibleWork(recentRecords.value, documents.value, activeSpaceId.value),
)
const recentlyUpdated = computed(() =>
  [...documents.value]
    .sort((left, right) => {
      const date = (document) =>
        new Date(document.updated_at || document.updatedAt || document.created_at || 0).getTime() || 0
      return date(right) - date(left)
    })
    .slice(0, 8),
)
const libraryDocuments = computed(() => {
  const query = libraryQuery.value.trim().toLocaleLowerCase()
  return filteredDocuments.value.filter(
    (document) => !query || (document.title || '').toLocaleLowerCase().includes(query),
  )
})
const kindCounts = computed(() =>
  Object.fromEntries(
    Object.keys(kindMeta).map((key) => [
      key,
      documents.value.filter((document) => (document.kind || 'doc') === key).length,
    ]),
  ),
)
const today = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(
  new Date(),
)

function sectionRoute(section, kind = null, spaceId = activeSpaceId.value) {
  return workbenchRoute({ section, kind, spaceId })
}

function showSection(section, kind = null) {
  router.push(sectionRoute(section, kind))
  sidebarOpen.value = false
}

function syncSpaceFromRoute() {
  if (!route.meta.dashboardSection || !spaces.value.length) return
  const requested = typeof route.query.space === 'string' ? route.query.space : ''
  const match = spaces.value.find((space) => String(space.id) === requested)
  const current = spaces.value.find((space) => String(space.id) === String(activeSpaceId.value))
  activeSpaceId.value = (match || current || spaces.value[0]).id
  if (String(activeSpaceId.value) !== requested) {
    router.replace({ path: route.path, query: { ...route.query, space: String(activeSpaceId.value) } })
  }
}

async function onRenamed({ docKey, title }) {
  for (const row of documents.value) {
    if ((row.doc_key || row.docKey) === docKey) row.title = title
  }
  await loadSpaceContent()
}

async function refreshContent() {
  if (refreshing.value) return
  refreshing.value = true
  try {
    recentRecords.value = readRecentWork(userId)
    await Promise.all([
      loadSpaceContent(),
      loadSpaces(),
      ...(activeSection.value === 'stats' ? [loadStats()] : []),
    ])
  } finally {
    refreshing.value = false
    lastRefreshAt = Date.now()
  }
}

function refreshWhenFocused() {
  if (Date.now() - lastRefreshAt < 30_000 || loading.spaces || submitting.value) return
  refreshContent()
}

async function loadSpaces(preferredId = null) {
  const request = spaceListRequests.begin()
  loading.spaces = true
  errors.spaces = ''
  try {
    const rows = await api('/api/spaces')
    if (!spaceListRequests.isCurrent(request)) return
    spaces.value = rows || []
    const saved =
      preferredId ||
      route.query.space ||
      sessionStorage.getItem(`collab_active_space:${userId}`) ||
      sessionStorage.getItem('collab_active_space')
    const match = spaces.value.find((space) => Number(space.id) === Number(saved))
    activeSpaceId.value = match?.id ?? spaces.value[0]?.id ?? null
    if (preferredId && activeSpaceId.value != null) {
      await router.replace(sectionRoute(activeSection.value, libraryKind.value))
    } else syncSpaceFromRoute()
  } catch (error) {
    if (spaceListRequests.isCurrent(request)) errors.spaces = error.message
  } finally {
    if (spaceListRequests.isCurrent(request)) loading.spaces = false
  }
}

async function loadSpaceContent(requestedSpaceId = activeSpaceId.value) {
  const request = spaceContentRequests.begin()
  const spaceId = requestedSpaceId == null ? '' : String(requestedSpaceId)
  errors.documents = ''
  errors.members = ''
  if (!spaceId) {
    documents.value = []
    members.value = []
    loading.documents = false
    loading.members = false
    return
  }
  sessionStorage.setItem('collab_active_space', spaceId)
  sessionStorage.setItem(`collab_active_space:${userId}`, spaceId)
  if (contentSpaceId !== spaceId) {
    documents.value = []
    members.value = []
  }
  contentSpaceId = spaceId
  loading.documents = true
  loading.members = true
  const id = encodeURIComponent(spaceId)
  const [docsResult, membersResult] = await Promise.allSettled([
    api(`/api/docs?spaceId=${id}`),
    api(`/api/spaces/${id}/members`),
  ])
  if (!spaceContentRequests.isCurrent(request) || String(activeSpaceId.value ?? '') !== spaceId) return
  if (docsResult.status === 'fulfilled') {
    documents.value = docsResult.value || []
    previewVersion.value += 1
  } else {
    if ([403, 404].includes(docsResult.reason.status)) documents.value = []
    errors.documents = docsResult.reason.message
  }
  if (membersResult.status === 'fulfilled')
    members.value = membersResult.value.members || membersResult.value || []
  else {
    if ([403, 404].includes(membersResult.reason.status)) members.value = []
    errors.members = membersResult.reason.message
  }
  loading.documents = false
  loading.members = false
}

async function loadStats() {
  const request = statsRequests.begin()
  loading.stats = true
  errors.stats = ''
  try {
    const result = await api('/api/stats')
    if (statsRequests.isCurrent(request)) stats.value = result
  } catch (error) {
    if (statsRequests.isCurrent(request)) errors.stats = error.message
  } finally {
    if (statsRequests.isCurrent(request)) loading.stats = false
  }
}

function selectSpace(space) {
  router.push(sectionRoute(activeSection.value, libraryKind.value, space.id))
  sidebarOpen.value = false
}

function openDocument(document) {
  const kind = document.kind || 'doc'
  router.push({ name: 'workspace', params: { kind, docKey: document.doc_key || document.docKey } })
}

function openCreate(kind = 'doc') {
  if (!canWrite.value) return
  createForm.kind = kind
  createForm.title = ''
  showCreateModal.value = true
}

async function createSpace() {
  if (submitting.value) return
  const name = spaceName.value.trim()
  if (!name) return
  submitting.value = true
  try {
    const result = await api('/api/spaces', { method: 'POST', body: { name } })
    showSpaceModal.value = false
    spaceName.value = ''
    await loadSpaces(result.spaceId)
    showSection('content')
    notify('空间已创建', 'success')
  } catch (error) {
    notify(error.message, 'error')
  } finally {
    submitting.value = false
  }
}

async function createDocument() {
  if (submitting.value || !activeSpaceId.value || !canWrite.value) return
  const kind = createForm.kind
  submitting.value = true
  try {
    const result = await api('/api/docs', {
      method: 'POST',
      body: {
        title: createForm.title.trim(),
        kind,
        spaceId: String(activeSpaceId.value),
      },
    })
    showCreateModal.value = false
    notify(`${kindMeta[kind].name}已创建`, 'success')
    await loadSpaceContent()
    openDocument({ ...result, kind: result.kind || kind })
  } catch (error) {
    notify(error.message, 'error')
  } finally {
    submitting.value = false
  }
}

async function inviteMember() {
  if (submitting.value || !isOwner.value) return
  const username = inviteForm.username.trim()
  if (!username || !activeSpaceId.value) return
  submitting.value = true
  try {
    await api(`/api/spaces/${encodeURIComponent(activeSpaceId.value)}/members`, {
      method: 'POST',
      body: { username, role: inviteForm.role },
    })
    showInviteModal.value = false
    inviteForm.username = ''
    notify('成员已加入空间', 'success')
    await loadSpaceContent()
  } catch (error) {
    notify(error.message, 'error')
  } finally {
    submitting.value = false
  }
}

function logout() {
  authStore.logout()
  router.replace('/login')
}

function allowNavigation() {
  if (
    authStore.isAuthenticated.value &&
    submitting.value &&
    (showSpaceModal.value || showCreateModal.value || showInviteModal.value)
  )
    return false
  showSpaceModal.value = false
  showCreateModal.value = false
  showInviteModal.value = false
  return true
}

onBeforeRouteUpdate(allowNavigation)
onBeforeRouteLeave(allowNavigation)

watch(activeSpaceId, loadSpaceContent)
watch(sortOrder, () => {
  saveDashboardPreferences(userId, {
    sort: sortOrder.value,
  })
})
watch(() => route.query.space, syncSpaceFromRoute)
watch(
  [activeSection, libraryKind, activeSpaceId],
  () => {
    if (!route.meta.dashboardSection) return
    sidebarOpen.value = false
    libraryQuery.value = ''
    rememberWorkbenchLocation(userId, {
      section: activeSection.value,
      kind: libraryKind.value,
      spaceId: activeSpaceId.value ?? route.query.space,
    })
  },
  { immediate: true },
)
watch(activeSection, (section) => {
  if (section === 'stats') loadStats()
})
onMounted(async () => {
  window.addEventListener('focus', refreshWhenFocused)
  await Promise.all([loadSpaces(), ...(activeSection.value === 'stats' ? [loadStats()] : [])])
  lastRefreshAt = Date.now()
})
onBeforeUnmount(() => {
  window.removeEventListener('focus', refreshWhenFocused)
  spaceListRequests.invalidate()
  spaceContentRequests.invalidate()
  statsRequests.invalidate()
})
</script>

<template>
  <WorkbenchLayout :navigation-open="sidebarOpen" @close-navigation="sidebarOpen = false">
    <template #sidebar>
      <div class="sidebar-brand">
        <span class="workbench-mark" aria-hidden="true"><FolderKanban :size="20" /></span>
        <div><strong>协同工作台</strong><small>让想法在这里汇合</small></div>
        <button
          class="icon-button sidebar-close"
          type="button"
          aria-label="关闭导航"
          @click="sidebarOpen = false"
        >
          <X :size="19" />
        </button>
      </div>
      <nav class="workbench-nav" aria-label="工作台功能">
        <RouterLink
          :to="sectionRoute('content')"
          :class="{ active: activeSection === 'content' }"
          :aria-current="activeSection === 'content' ? 'page' : undefined"
          @click="sidebarOpen = false"
        >
          <Home :size="17" />空间首页
        </RouterLink>
        <RouterLink
          v-for="(meta, key) in kindMeta"
          :key="key"
          :to="sectionRoute('library', key)"
          :class="{ active: libraryKind === key }"
          :aria-current="libraryKind === key ? 'page' : undefined"
          @click="sidebarOpen = false"
        >
          <component :is="meta.icon" :size="17" />{{ meta.name
          }}<span aria-hidden="true">{{ loading.documents ? '—' : kindCounts[key] }}</span>
        </RouterLink>
      </nav>
      <div class="sidebar-label">
        <span>我的空间</span
        ><button
          class="icon-button subtle"
          type="button"
          aria-label="创建空间"
          title="创建空间"
          @click="showSpaceModal = true"
        >
          <Plus :size="15" />
        </button>
      </div>
      <nav class="space-nav" aria-label="空间列表">
        <div v-if="loading.spaces" class="sidebar-state">正在加载空间</div>
        <button
          v-for="space in spaces"
          v-else
          :key="space.id"
          type="button"
          :class="{ active: Number(space.id) === Number(activeSpaceId) }"
          @click="selectSpace(space)"
        >
          <span class="space-letter" aria-hidden="true">{{ Array.from(space.name || '空')[0] }}</span>
          <span
            ><strong>{{ space.name }}</strong
            ><small>{{ space.doc_count ?? 0 }} 个内容</small></span
          >
        </button>
        <p v-if="!loading.spaces && !errors.spaces && !spaces.length" class="sidebar-state">尚无空间</p>
      </nav>
      <nav class="workbench-nav secondary-nav" aria-label="空间管理">
        <RouterLink
          :to="sectionRoute('members')"
          :class="{ active: activeSection === 'members' }"
          :aria-current="activeSection === 'members' ? 'page' : undefined"
          @click="sidebarOpen = false"
        >
          <Users :size="17" />空间成员
        </RouterLink>
        <RouterLink
          :to="sectionRoute('stats')"
          :class="{ active: activeSection === 'stats' }"
          :aria-current="activeSection === 'stats' ? 'page' : undefined"
          @click="sidebarOpen = false"
        >
          <ChartNoAxesCombined :size="17" />协同统计
        </RouterLink>
        <RouterLink
          v-if="isOwner"
          :to="sectionRoute('trash')"
          :class="{ active: activeSection === 'trash' }"
          :aria-current="activeSection === 'trash' ? 'page' : undefined"
          @click="sidebarOpen = false"
          ><Trash2 :size="17" />回收站</RouterLink
        >
      </nav>
      <div class="sidebar-account">
        <RouterLink class="sidebar-profile-link" to="/profile" aria-label="进入个人主页" title="个人主页">
          <UserAvatar :name="authStore.displayName.value" :source="authStore.state.user?.avatarUrl || ''" />
          <span
            ><strong>{{ authStore.displayName.value }}</strong
            ><small>个人主页与账号</small></span
          >
        </RouterLink>
        <button class="icon-button" type="button" aria-label="退出登录" title="退出登录" @click="logout">
          <LogOut :size="16" />
        </button>
      </div>
    </template>

    <header class="topbar">
      <button class="icon-button menu-button" type="button" aria-label="打开导航" @click="sidebarOpen = true">
        <Menu :size="20" />
      </button>
      <div class="workbench-breadcrumb">
        <FolderKanban :size="16" /><span>{{ activeSpace?.name || '工作台' }}</span
        ><ChevronRight :size="14" /><strong>{{ sectionName }}</strong>
      </div>
      <ContentSearch @open="openDocument" />
      <RouterLink class="topbar-user" to="/profile" aria-label="个人主页"
        ><UserAvatar :name="authStore.displayName.value" :source="authStore.state.user?.avatarUrl || ''"
      /></RouterLink>
    </header>

    <div class="dashboard-content" :class="{ 'library-page': libraryMeta }">
      <section class="dashboard-heading" :class="{ 'library-heading': libraryMeta }">
        <div class="dashboard-title-block">
          <p class="dashboard-date">{{ libraryMeta ? activeSpace?.name || '当前空间' : today }}</p>
          <div class="dashboard-title-line">
            <span
              v-if="libraryMeta"
              class="library-title-icon"
              :class="`kind-${libraryKind}`"
              aria-hidden="true"
            >
              <component :is="libraryMeta.icon" :size="24" :stroke-width="1.7" />
            </span>
            <h1>
              {{
                libraryMeta
                  ? libraryMeta.name
                  : activeSection === 'content'
                    ? activeSpace?.name || '工作台'
                    : sectionName
              }}
            </h1>
            <span v-if="activeSpace" class="role-badge" :class="{ readonly: !canWrite }">{{
              roleNames[activeRole] || activeRole
            }}</span>
          </div>
          <p class="dashboard-description">
            {{
              libraryMeta
                ? libraryMeta.libraryDescription
                : activeSection === 'members'
                  ? '与伙伴一起，让协作有条不紊。'
                  : activeSection === 'stats'
                    ? '回顾团队的协作与积累。'
                    : activeSection === 'trash'
                      ? '找回误删的内容，继续之前的工作。'
                      : '接着上次的内容，或开始一次新的协作。'
            }}
          </p>
        </div>
        <button
          v-if="canWrite && ['content', 'library'].includes(activeSection)"
          class="button primary"
          type="button"
          @click="openCreate(libraryKind || 'doc')"
        >
          <Plus :size="17" />{{ libraryMeta?.title || '新建内容' }}
        </button>
      </section>
      <div v-if="errors.spaces" class="dashboard-request-error" role="alert">
        <TriangleAlert :size="20" />
        <div>
          <strong>暂时无法加载空间</strong>
          <p>{{ errors.spaces }}</p>
        </div>
        <button class="button secondary" type="button" @click="loadSpaces()">
          <RotateCw :size="15" />重新加载空间
        </button>
      </div>
      <div v-if="!loading.spaces && !errors.spaces && !spaces.length" class="first-space-state">
        <FolderKanban :size="28" />
        <h2>创建第一个空间</h2>
        <p>把文档、想法和协作伙伴放在一起。</p>
        <button class="button primary" type="button" @click="showSpaceModal = true">
          <Plus :size="18" />创建空间
        </button>
      </div>
      <template v-else-if="activeSpace || loading.spaces">
        <template v-if="activeSection === 'content'">
          <section v-if="canWrite" class="creation-launchpad" aria-label="快速创建">
            <button
              v-for="(meta, key) in kindMeta"
              :key="key"
              :class="`create-tile create-${key}`"
              type="button"
              :aria-label="meta.title"
              @click="openCreate(key)"
            >
              <span class="create-tile-icon"
                ><component :is="meta.icon" :size="23" :stroke-width="1.7"
              /></span>
              <span class="create-tile-copy"
                ><strong>{{ meta.title }}</strong
                ><small>{{ meta.description }}</small></span
              ><Plus class="create-tile-plus" :size="17" />
            </button>
          </section>
          <RecentWork v-if="!errors.documents" :documents="recentDocuments" @open="openDocument" />
          <section class="content-section" aria-labelledby="content-heading">
            <div class="section-heading content-heading-row">
              <h2 id="content-heading">最近更新</h2>
              <div class="content-tools">
                <span class="home-content-hint">{{
                  documents.length > 8 ? '显示最近 8 项' : '当前空间的协作内容'
                }}</span>
                <button
                  class="icon-button home-refresh"
                  type="button"
                  aria-label="刷新内容"
                  title="刷新内容"
                  :disabled="refreshing || loading.documents"
                  @click="refreshContent"
                >
                  <RotateCw :size="15" :class="{ spin: refreshing }" />
                </button>
              </div>
            </div>
            <div v-if="errors.documents" class="dashboard-request-error" role="alert">
              <TriangleAlert :size="20" />
              <div>
                <strong>暂时无法加载内容</strong>
                <p>{{ errors.documents }}</p>
              </div>
              <button class="button secondary" type="button" @click="loadSpaceContent()">
                <RotateCw :size="15" />重新加载内容
              </button>
            </div>
            <div v-if="!loading.documents && !errors.documents && !documents.length" class="dashboard-empty">
              <span class="empty-document-icon"><FileText :size="28" :stroke-width="1.5" /></span>
              <h3>你的下一份灵感，从这里开始</h3>
              <p>
                {{
                  canWrite
                    ? '创建内容并邀请伙伴，一起把想法变成成果。'
                    : '空间内容会出现在这里，等待伙伴分享第一份内容。'
                }}
              </p>
              <button v-if="canWrite" class="button secondary" type="button" @click="openCreate('doc')">
                <Plus :size="16" />创建第一份文档
              </button>
            </div>
            <template v-else-if="loading.documents || recentlyUpdated.length"
              ><div v-if="!loading.documents" class="document-table-head" aria-hidden="true">
                <span>名称</span><span>最后更新</span><span />
              </div>
              <DocumentList
                :documents="recentlyUpdated"
                :loading="loading.documents && !documents.length"
                :show-space="false"
                actions
                @open="openDocument"
                @renamed="onRenamed"
                @deleted="refreshContent"
            /></template>
            <p v-if="documents.length > 8" class="home-content-note">
              完整内容可从左侧的文档、白板和看板栏目查看。
            </p>
          </section>
          <footer class="dashboard-footer">
            <span
              >{{ members.length }} 位空间成员<span class="footer-divider">/</span
              >{{ documents.length }} 个协作内容</span
            ><button type="button" @click="showSection('members')">
              管理空间成员<ArrowUpRight :size="14" />
            </button>
          </footer>
        </template>
        <section v-else-if="libraryMeta" class="library-section" :aria-label="`${libraryMeta.name}库`">
          <div class="library-toolbar">
            <h2>
              全部{{ libraryMeta.name }}<span>{{ loading.documents ? '—' : kindCounts[libraryKind] }}</span>
            </h2>
            <div class="library-tools">
              <label class="library-search">
                <Search :size="15" aria-hidden="true" />
                <input
                  v-model="libraryQuery"
                  type="search"
                  :aria-label="`查找${libraryMeta.name}`"
                  :placeholder="`查找${libraryMeta.name}…`"
                />
              </label>
              <label class="document-sort">
                <ArrowDownUp :size="14" aria-hidden="true" />
                <select v-model="sortOrder" aria-label="内容排序">
                  <option value="updated">最近更新</option>
                  <option value="title">名称排序</option>
                </select>
              </label>
              <button
                class="icon-button home-refresh"
                type="button"
                aria-label="刷新内容"
                title="刷新内容"
                :disabled="refreshing || loading.documents"
                @click="refreshContent"
              >
                <RotateCw :size="15" :class="{ spin: refreshing }" />
              </button>
            </div>
          </div>
          <div v-if="errors.documents" class="dashboard-request-error" role="alert">
            <TriangleAlert :size="20" />
            <div>
              <strong>暂时无法加载{{ libraryMeta.name }}</strong>
              <p>{{ errors.documents }}</p>
            </div>
            <button class="button secondary" type="button" @click="loadSpaceContent()">
              <RotateCw :size="15" />重新加载内容
            </button>
          </div>
          <template v-else>
            <div v-if="!loading.documents && !libraryDocuments.length" class="dashboard-empty library-empty">
              <span class="empty-document-icon" :class="`kind-${libraryKind}`">
                <component
                  :is="libraryQuery.trim() ? Search : libraryMeta.icon"
                  :size="28"
                  :stroke-width="1.5"
                />
              </span>
              <h3>
                {{ libraryQuery.trim() ? `没有找到匹配的${libraryMeta.name}` : `还没有${libraryMeta.name}` }}
              </h3>
              <p>
                {{
                  libraryQuery.trim()
                    ? '试试其他名称，或清除查找查看全部内容。'
                    : canWrite
                      ? libraryMeta.description
                      : `伙伴创建的${libraryMeta.name}会显示在这里。`
                }}
              </p>
              <button
                v-if="libraryQuery.trim()"
                class="button secondary"
                type="button"
                @click="libraryQuery = ''"
              >
                清除查找
              </button>
              <button
                v-else-if="canWrite"
                class="button secondary"
                type="button"
                @click="openCreate(libraryKind)"
              >
                <Plus :size="16" />创建第一份{{ libraryMeta.name }}
              </button>
            </div>
            <ContentLibrary
              v-else
              :key="`${activeSpaceId}:${libraryKind}`"
              :kind="libraryKind"
              :documents="libraryDocuments"
              :refresh-version="previewVersion"
              :loading="loading.documents && !documents.length"
              @open="openDocument"
              @renamed="onRenamed"
              @deleted="refreshContent"
            />
          </template>
        </section>
        <TrashPanel
          v-else-if="activeSection === 'trash' && activeSpaceId"
          :space-id="activeSpaceId"
          :can-manage="isOwner"
          @restored="refreshContent"
          @open="openDocument"
        />
        <section
          v-else-if="activeSection === 'members'"
          class="members-section"
          aria-labelledby="members-heading"
        >
          <div class="section-heading">
            <div>
              <h2 id="members-heading">
                空间成员 <span class="section-count">{{ members.length }}</span>
              </h2>
              <p class="section-description">成员的访问权限仅适用于当前空间</p>
            </div>
            <button
              v-if="isOwner"
              class="button primary"
              type="button"
              aria-label="邀请成员"
              @click="showInviteModal = true"
            >
              <UserPlus :size="16" />邀请成员
            </button>
          </div>
          <div v-if="errors.members" class="dashboard-request-error" role="alert">
            <TriangleAlert :size="20" />
            <div>
              <strong>暂时无法加载成员</strong>
              <p>{{ errors.members }}</p>
            </div>
            <button class="button secondary" type="button" @click="loadSpaceContent()">
              <RotateCw :size="15" />重新加载成员
            </button>
          </div>
          <div v-if="loading.members && !members.length" class="panel-state">正在加载成员</div>
          <div v-else-if="members.length || !errors.members" class="member-list">
            <div v-for="member in members" :key="`${activeSpaceId}:${member.id}`" class="member-row">
              <UserAvatar
                class="small-avatar"
                :name="member.nickname || member.username || '用户'"
                :source="member.avatar_url || ''"
              /><span
                ><strong>{{ member.nickname || member.username }}</strong
                ><small>@{{ member.username }}</small></span
              ><em :class="`member-role role-${member.role}`">{{ roleNames[member.role] || member.role }}</em>
              <MemberActions
                v-if="isOwner && !['owner', 'admin'].includes(member.role)"
                :member="member"
                :space-id="activeSpaceId"
                @changed="refreshContent"
              />
            </div>
            <p v-if="!members.length" class="empty-inline">暂无成员</p>
          </div>
        </section>
        <div v-else class="dashboard-statistics">
          <p class="stats-scope-note">统计范围：你加入的全部空间中可见的内容。</p>
          <div v-if="errors.stats" class="dashboard-request-error" role="alert">
            <TriangleAlert :size="20" />
            <div>
              <strong>暂时无法加载统计</strong>
              <p>{{ errors.stats }}</p>
            </div>
            <button class="button secondary" type="button" @click="loadStats">
              <RotateCw :size="15" />重新加载统计
            </button>
          </div>
          <StatsPanel v-if="stats || !errors.stats" :stats="stats" :loading="loading.stats && !stats" />
        </div>
      </template>
    </div>
  </WorkbenchLayout>
  <div class="dashboard-dialogs">
    <BaseModal
      v-if="showSpaceModal"
      title="创建空间"
      description="空间中的内容与成员彼此隔离"
      :close-disabled="submitting"
      @close="!submitting && (showSpaceModal = false)"
    >
      <form id="space-form" class="modal-form" @submit.prevent="createSpace">
        <label
          ><span>空间名称</span
          ><input
            v-model="spaceName"
            :disabled="submitting"
            maxlength="128"
            placeholder="例如：毕业设计小组"
            autofocus
        /></label>
      </form>
      <template #footer
        ><button
          class="button secondary"
          type="button"
          :disabled="submitting"
          @click="showSpaceModal = false"
        >
          取消</button
        ><button class="button primary" form="space-form" :disabled="submitting || !spaceName.trim()">
          {{ submitting ? '正在创建' : '创建空间' }}
        </button></template
      >
    </BaseModal>

    <BaseModal
      v-if="showCreateModal"
      :title="kindMeta[createForm.kind].title"
      :description="`创建在“${activeSpace?.name || ''}”空间`"
      :close-disabled="submitting"
      @close="!submitting && (showCreateModal = false)"
    >
      <form id="content-form" class="modal-form" @submit.prevent="createDocument">
        <div v-if="!libraryMeta" class="segmented kind-picker" aria-label="内容类型">
          <button
            v-for="(meta, key) in kindMeta"
            :key="key"
            type="button"
            :disabled="submitting"
            :class="{ active: createForm.kind === key }"
            @click="createForm.kind = key"
          >
            <component :is="meta.icon" :size="17" />{{ meta.name }}
          </button>
        </div>
        <label
          ><span>标题</span
          ><input
            v-model="createForm.title"
            :disabled="submitting"
            maxlength="256"
            :placeholder="kindMeta[createForm.kind].placeholder"
            autofocus
        /></label>
      </form>
      <template #footer
        ><button
          class="button secondary"
          type="button"
          :disabled="submitting"
          @click="showCreateModal = false"
        >
          取消</button
        ><button class="button primary" form="content-form" :disabled="submitting">
          {{ submitting ? '正在创建' : '创建并打开' }}
        </button></template
      >
    </BaseModal>

    <BaseModal
      v-if="showInviteModal"
      title="邀请成员"
      :description="`加入“${activeSpace?.name || ''}”空间`"
      :close-disabled="submitting"
      @close="!submitting && (showInviteModal = false)"
    >
      <form id="invite-form" class="modal-form" @submit.prevent="inviteMember">
        <label
          ><span>用户名</span
          ><input
            v-model="inviteForm.username"
            :disabled="submitting"
            maxlength="32"
            placeholder="输入已注册用户名"
            autofocus
        /></label>
        <fieldset :disabled="submitting">
          <legend>成员角色</legend>
          <label class="radio-row"
            ><input v-model="inviteForm.role" type="radio" value="editor" /><span
              ><strong>编辑者</strong><small>可创建和编辑空间内容</small></span
            ></label
          ><label class="radio-row"
            ><input v-model="inviteForm.role" type="radio" value="viewer" /><span
              ><strong>只读者</strong><small>仅可查看内容与历史版本</small></span
            ></label
          >
        </fieldset>
      </form>
      <template #footer
        ><button
          class="button secondary"
          type="button"
          :disabled="submitting"
          @click="showInviteModal = false"
        >
          取消</button
        ><button
          class="button primary"
          form="invite-form"
          :disabled="submitting || !inviteForm.username.trim()"
        >
          <UserPlus :size="17" />{{ submitting ? '正在邀请' : '邀请成员' }}
        </button></template
      >
    </BaseModal>
  </div>
</template>
