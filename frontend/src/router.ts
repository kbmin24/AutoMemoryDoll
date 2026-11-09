import { createRouter, createWebHistory, type RouterHistory } from 'vue-router';
import { watch } from 'vue';
import { refreshSession, session } from './api/client';
import LoginView from './views/LoginView.vue';
import AccountView from './views/AccountView.vue';
import AdminUsersView from './views/AdminUsersView.vue';
import TemplatesView from './views/TemplatesView.vue';
import TemplateWorkspaceView from './views/TemplateWorkspaceView.vue';

export function createAppRouter(history: RouterHistory = createWebHistory()) {
  let initialized = false;
  const router = createRouter({
    history,
    routes: [
      { path: '/', redirect: '/templates' },
      { path: '/login', component: LoginView },
      { path: '/templates', component: TemplatesView },
      { path: '/templates/new', component: TemplateWorkspaceView },
      { path: '/templates/:id/edit', component: TemplateWorkspaceView },
      { path: '/account', component: AccountView },
      {
        path: '/admin/users',
        component: AdminUsersView,
        meta: { admin: true },
      },
      { path: '/:pathMatch(.*)*', redirect: '/templates' },
    ],
  });
  router.beforeEach(async (to) => {
    if (!initialized) {
      try {
        await refreshSession();
      } catch {
        // Login offers a retry when session restoration is unavailable.
      }
      initialized = true;
    }
    if (!session.user && to.path !== '/login') return '/login';
    if (session.user && to.path === '/login') return '/templates';
    if (to.meta.admin && session.user?.role === 'user') return '/templates';
  });
  return router;
}

export function watchSession(router: ReturnType<typeof createAppRouter>) {
  return watch(
    () => session.user,
    (user) => {
      if (!user) void router.replace('/login');
    },
    { flush: 'sync' },
  );
}
