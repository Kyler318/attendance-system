<script setup>
import { ref, onMounted } from 'vue';
import http from '../api/http';

const classSubjects = ref([]);
const loading = ref(true);

onMounted(async () => {
  const { data } = await http.get('/teacher/class-subjects');
  classSubjects.value = data;
  loading.value = false;
});
</script>

<template>
  <div class="page">
    <h2>我負責嘅班級</h2>
    <p v-if="loading" class="muted">載入緊...</p>
    <p v-else-if="classSubjects.length === 0" class="muted">你暫時未有負責任何班級,請聯絡管理員指派。</p>
    <div v-else style="display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px">
      <router-link
        v-for="cs in classSubjects"
        :key="cs.id"
        :to="{ name: 'class-workspace', params: { id: cs.id } }"
        class="card"
        style="text-decoration: none; color: inherit"
      >
        <h3 style="margin: 0 0 6px">{{ cs.class_name }}</h3>
        <div class="muted">科目:{{ cs.subject_name }}</div>
        <div class="muted" v-if="cs.homeroom_teacher">導師:{{ cs.homeroom_teacher }}</div>
      </router-link>
    </div>
  </div>
</template>
