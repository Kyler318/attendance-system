<script setup>
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from './stores/auth';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

const showTopbar = computed(() => !!auth.user && route.name !== 'login');

async function handleLogout() {
  await auth.logout();
  router.push({ name: 'login' });
}
</script>

<template>
  <div class="topbar" v-if="showTopbar">
    <div class="row">
      <strong>課堂點名系統</strong>
      <router-link v-if="auth.isTeacher" :to="{ name: 'teacher-dashboard' }">我嘅班級</router-link>
      <router-link v-if="auth.isAdmin" :to="{ name: 'admin-dashboard' }">管理後台</router-link>
    </div>
    <div class="row">
      <span class="muted">{{ auth.user?.displayName }} ({{ auth.user?.role === 'admin' ? '管理員' : '老師' }})</span>
      <router-link :to="{ name: 'account' }">帳戶設定</router-link>
      <button @click="handleLogout">登出</button>
    </div>
  </div>
  <router-view />
</template>
