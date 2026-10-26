import { createRouter, createWebHashHistory } from 'vue-router'
import { authStore } from '../stores/auth.js'

const workbenchView = () => import('../views/DashboardView.vue')

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('../views/LoginView.vue'),
      meta: { public: true },
    },
    {
      path: '/',
      name: 'dashboard',
      component: workbenchView,
      meta: { dashboardSection: 'content' },
    },
    {
      path: '/library/:kind(doc|board|kanban)',
      name: 'content-library',
      component: workbenchView,
      meta: { dashboardSection: 'library' },
    },
    {
      path: '/members',
      name: 'space-members',
      component: workbenchView,
      meta: { dashboardSection: 'members' },
    },
    {
      path: '/stats',
      name: 'collaboration-stats',
      component: workbenchView,
      meta: { dashboardSection: 'stats' },
    },
    {
      path: '/trash',
      name: 'space-trash',
      component: workbenchView,
      meta: { dashboardSection: 'trash' },
    },
    {
      path: '/profile',
      name: 'profile',
      component: () => import('../views/ProfileView.vue'),
    },
    {
      path: '/work/:kind(doc|board|kanban)/:docKey',
      name: 'workspace',
      component: () => import('../views/WorkspaceView.vue'),
      props: true,
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
  scrollBehavior: () => ({ top: 0 }),
})

router.beforeEach(async (to) => {
  await authStore.init()
  if (!to.meta.public && !authStore.isAuthenticated.value) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }
  if (to.name === 'login' && authStore.isAuthenticated.value) return { name: 'dashboard' }
  return true
})

export default router
