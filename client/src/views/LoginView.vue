<script setup>
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const username = ref('');
const password = ref('');
const rememberMe = ref(false);
const error = ref('');
const loading = ref(false);

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

async function handleSubmit() {
  error.value = '';
  loading.value = true;
  try {
    await auth.login(username.value, password.value, rememberMe.value);
    const redirect = route.query.redirect;
    router.push(redirect && typeof redirect === 'string' ? redirect : { name: 'home' });
  } catch (e) {
    error.value = e.response?.data?.error || '登入失敗';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="page" style="max-width: 380px; margin-top: 80px">
    <div class="card">
      <h2 style="margin-top: 0">課堂點名系統登入</h2>
      <form @submit.prevent="handleSubmit" style="display: flex; flex-direction: column; gap: 12px">
        <label>
          帳號
          <input v-model="username" type="text" autocomplete="username" required style="width: 100%; margin-top: 4px" />
        </label>
        <label>
          密碼
          <input v-model="password" type="password" autocomplete="current-password" required style="width: 100%; margin-top: 4px" />
        </label>
        <label class="row" style="gap: 6px">
          <input v-model="rememberMe" type="checkbox" />
          記住我(下次自動登入)
        </label>
        <div v-if="error" class="error-box">{{ error }}</div>
        <button class="primary" type="submit" :disabled="loading">{{ loading ? '登入中...' : '登入' }}</button>
      </form>
    </div>
  </div>
</template>
