<script setup>
import { ref } from 'vue';
import http from '../api/http';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const oldPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const error = ref('');
const success = ref('');
const loading = ref(false);

async function handleSubmit() {
  error.value = '';
  success.value = '';
  if (newPassword.value !== confirmPassword.value) {
    error.value = '兩次輸入嘅新密碼不一致';
    return;
  }
  loading.value = true;
  try {
    await http.post('/auth/change-password', { oldPassword: oldPassword.value, newPassword: newPassword.value });
    success.value = '密碼已更新';
    oldPassword.value = '';
    newPassword.value = '';
    confirmPassword.value = '';
    auth.user.mustChangePassword = false;
  } catch (e) {
    error.value = e.response?.data?.error || '更改密碼失敗';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="page" style="max-width: 420px">
    <div class="card">
      <h2 style="margin-top: 0">帳戶設定</h2>
      <p class="muted">帳號:{{ auth.user?.username }} ({{ auth.user?.displayName }})</p>
      <div v-if="auth.user?.mustChangePassword" class="error-box" style="margin-bottom: 12px">
        呢個帳號使用緊臨時密碼,請盡快更改。
      </div>
      <form @submit.prevent="handleSubmit" style="display: flex; flex-direction: column; gap: 12px">
        <label>
          原密碼
          <input v-model="oldPassword" type="password" required style="width: 100%; margin-top: 4px" />
        </label>
        <label>
          新密碼(最少 6 個字元)
          <input v-model="newPassword" type="password" required minlength="6" style="width: 100%; margin-top: 4px" />
        </label>
        <label>
          確認新密碼
          <input v-model="confirmPassword" type="password" required minlength="6" style="width: 100%; margin-top: 4px" />
        </label>
        <div v-if="error" class="error-box">{{ error }}</div>
        <div v-if="success" class="success-box">{{ success }}</div>
        <button class="primary" type="submit" :disabled="loading">更改密碼</button>
      </form>
    </div>
  </div>
</template>
