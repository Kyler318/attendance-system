<script setup>
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const router = useRouter();

onMounted(() => {
  if (auth.isAdmin) router.replace({ name: 'admin-dashboard' });
  else router.replace({ name: 'teacher-dashboard' });
});
</script>

<template>
  <div class="page"><p class="muted">載入緊...</p></div>
</template>
