import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const routes = [
  { path: '/login', name: 'login', component: () => import('../views/LoginView.vue'), meta: { public: true } },
  { path: '/', name: 'home', component: () => import('../views/HomeRedirect.vue') },
  { path: '/teacher', name: 'teacher-dashboard', component: () => import('../views/TeacherDashboard.vue'), meta: { role: 'teacher' } },
  { path: '/class/:id', name: 'class-workspace', component: () => import('../views/ClassWorkspaceView.vue') },
  { path: '/admin', name: 'admin-dashboard', component: () => import('../views/AdminDashboard.vue'), meta: { role: 'admin' } },
  { path: '/account', name: 'account', component: () => import('../views/AccountSettingsView.vue') },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  if (!auth.loaded) await auth.fetchMe();

  if (!to.meta.public && !auth.user) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  if (to.meta.public && auth.user && to.name === 'login') {
    return { name: 'home' };
  }
  if (to.meta.role && auth.user && auth.user.role !== to.meta.role) {
    return { name: 'home' };
  }
  return true;
});

export default router;
