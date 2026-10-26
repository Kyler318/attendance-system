<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import http from '../api/http';

const route = useRoute();
const router = useRouter();
const csId = computed(() => route.params.id);

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const info = ref(null);
const date = ref(route.query.date || todayStr());
const present = ref([]); // 嗰日有出席嘅學生
const remaining = ref([]); // 仲喺轉盤入面(未抽過)嘅學生
const records = ref([]); // 嗰日嘅抽籤記錄(按抽中次序)
const loading = ref(false);
const err = ref('');

// 轉盤上面實際畫出嚟嘅學生。抽中之後先唔即刻移走,等個指針停喺抽中嗰格、高亮顯示,
// 到下一次撳抽籤先至移出轉盤(否則一停低就重新排格,指針會指住第二個人)
const wheelStudents = ref([]);

function applyState(data, { keepWheel = false } = {}) {
  present.value = data.present;
  remaining.value = data.remaining;
  records.value = data.records;
  if (!keepWheel) wheelStudents.value = data.remaining;
}

async function load() {
  err.value = '';
  winner.value = null;
  loading.value = true;
  try {
    const { data } = await http.get(`/teacher/class-subjects/${csId.value}/draw`, { params: { date: date.value } });
    applyState(data);
  } catch (e) {
    err.value = e.response?.data?.error || '載入失敗';
  } finally {
    loading.value = false;
  }
}

watch(date, (d) => {
  router.replace({ query: { ...route.query, date: d } });
  load();
});

// ---- 轉盤 ----
const SIZE = 440;
const C = SIZE / 2;
const R = C - 8;
const COLORS = ['#2563eb', '#f59e0b', '#16a34a', '#db2777', '#7c3aed', '#0891b2', '#ea580c', '#4f46e5', '#65a30d', '#e11d48'];
const SPIN_MS = 5000;

const rotation = ref(0);
const spinning = ref(false);
const winner = ref(null);
let spinTimer = null;

// 角度以正上方為 0°、順時針計
function point(angleDeg, radius) {
  const a = (angleDeg * Math.PI) / 180;
  return [C + radius * Math.sin(a), C - radius * Math.cos(a)];
}

const segments = computed(() => {
  const n = wheelStudents.value.length;
  if (n === 0) return [];
  const seg = 360 / n;
  const fontSize = Math.max(10, Math.min(20, seg * 1.1));
  return wheelStudents.value.map((s, i) => {
    const start = i * seg;
    const end = start + seg;
    const [x1, y1] = point(start, R);
    const [x2, y2] = point(end, R);
    const largeArc = seg > 180 ? 1 : 0;
    // 避免頭尾相鄰兩格同色
    let color = COLORS[i % COLORS.length];
    if (i === n - 1 && n > 1 && i % COLORS.length === 0) color = COLORS[1];
    return {
      student: s,
      path: `M ${C} ${C} L ${x1} ${y1} A ${R} ${R} 0 ${largeArc} 1 ${x2} ${y2} Z`,
      color,
      labelTransform: `rotate(${start + seg / 2 - 90} ${C} ${C})`,
      fontSize,
      dimmed: !!winner.value && !spinning.value && winner.value.id !== s.id,
    };
  });
});

function spin() {
  if (spinning.value || remaining.value.length === 0) return;
  err.value = '';
  winner.value = null;
  wheelStudents.value = remaining.value; // 上一個抽中嘅學生喺呢度先正式移出轉盤
  const n = wheelStudents.value.length;
  const idx = Math.floor(Math.random() * n);
  const picked = wheelStudents.value[idx];
  const seg = 360 / n;
  // 令被抽中嗰格(加少少隨機偏移,唔會次次停正中)停喺正上方個指針度
  const target = (idx + 0.5) * seg + (Math.random() - 0.5) * seg * 0.7;
  const current = ((rotation.value % 360) + 360) % 360;
  const delta = (((360 - target - current) % 360) + 360) % 360;
  rotation.value += 360 * 6 + delta;
  spinning.value = true;

  spinTimer = setTimeout(async () => {
    try {
      const { data } = await http.post(`/teacher/class-subjects/${csId.value}/draw`, { date: date.value, studentId: picked.id });
      winner.value = picked;
      applyState(data, { keepWheel: true });
    } catch (e) {
      err.value = e.response?.data?.error || '記錄抽籤結果失敗,請重試';
      await load();
    } finally {
      spinning.value = false;
    }
  }, SPIN_MS + 200);
}

async function resetWheel() {
  if (!confirm(`確定要重置 ${date.value} 嘅轉盤?嗰日嘅抽籤記錄會清除,全部出席學生會放返入轉盤。(唔會影響出席同評分記錄)`)) return;
  err.value = '';
  winner.value = null;
  try {
    const { data } = await http.delete(`/teacher/class-subjects/${csId.value}/draw`, { params: { date: date.value } });
    applyState(data);
  } catch (e) {
    err.value = e.response?.data?.error || '重置失敗';
  }
}

// Postgres now()::text 例如 "2026-10-26 10:23:45.123+08",轉做本地時間 HH:MM
function timeOf(text) {
  const d = new Date(String(text).replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'));
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit', hour12: false });
}

onMounted(async () => {
  const { data } = await http.get(`/teacher/class-subjects/${csId.value}`);
  info.value = data;
  await load();
});
onBeforeUnmount(() => clearTimeout(spinTimer));
</script>

<template>
  <div class="page">
    <div class="row">
      <router-link :to="{ name: 'class-workspace', params: { id: csId } }"><button class="sm">← 返回點名</button></router-link>
      <h2 style="margin: 0">抽籤轉盤</h2>
      <span class="muted" v-if="info">{{ info.class_name }} - {{ info.subject_name }}</span>
      <div class="spacer" />
      <label class="field-group">
        <span class="label">日期</span>
        <input type="date" v-model="date" :disabled="spinning" />
      </label>
    </div>

    <div v-if="err" class="error-box">{{ err }}</div>

    <div class="draw-layout">
      <div class="card wheel-card">
        <p v-if="loading" class="muted">載入緊...</p>
        <template v-else-if="present.length === 0">
          <p class="muted">呢日未有學生出席記錄,請先喺點名頁面儲存當日出席。</p>
        </template>
        <template v-else>
          <div class="muted">轉盤入面有 {{ remaining.length }} / {{ present.length }} 位當日出席嘅學生</div>

          <div v-if="wheelStudents.length > 0" class="wheel-wrap">
            <div class="pointer" />
            <svg :viewBox="`0 0 ${SIZE} ${SIZE}`" class="wheel">
              <g
                :style="{
                  transform: `rotate(${rotation}deg)`,
                  transformOrigin: '50% 50%',
                  transition: spinning ? `transform ${SPIN_MS}ms cubic-bezier(0.15, 0.6, 0.1, 1)` : 'none',
                }"
              >
                <circle v-if="segments.length === 1" :cx="C" :cy="C" :r="R" :fill="segments[0].color" />
                <template v-else>
                  <path
                    v-for="seg in segments"
                    :key="seg.student.id"
                    :d="seg.path"
                    :fill="seg.color"
                    :opacity="seg.dimmed ? 0.25 : 1"
                    stroke="#fff"
                    stroke-width="2"
                  />
                </template>
                <g v-for="seg in segments" :key="`t${seg.student.id}`" :transform="seg.labelTransform">
                  <text
                    :x="C + R * 0.58"
                    :y="C"
                    fill="#fff"
                    :font-size="seg.fontSize"
                    font-weight="600"
                    text-anchor="middle"
                    dominant-baseline="central"
                  >
                    {{ seg.student.seat_no }}. {{ seg.student.name }}
                  </text>
                </g>
              </g>
              <circle :cx="C" :cy="C" r="34" fill="#fff" stroke="#e2e5ea" stroke-width="3" />
            </svg>
            <button class="primary spin-btn" :disabled="spinning || remaining.length === 0" @click="spin">{{ spinning ? '...' : '抽!' }}</button>
          </div>
          <div v-else class="success-box">全部出席學生都已經抽過,可以按「重置轉盤」重新開始。</div>
          <div v-if="wheelStudents.length > 0 && remaining.length === 0 && !spinning" class="success-box">
            全部出席學生都已經抽過,可以按「重置轉盤」重新開始。
          </div>

          <div v-if="winner" class="winner">
            抽中:<strong>{{ winner.seat_no }}. {{ winner.name }}</strong>,請回答!
          </div>

          <div class="row" style="justify-content: center">
            <button class="primary" :disabled="spinning || remaining.length === 0" @click="spin">
              {{ spinning ? '轉緊...' : '開始抽籤' }}
            </button>
            <button :disabled="spinning || records.length === 0" @click="resetWheel">重置轉盤</button>
          </div>
        </template>
      </div>

      <div class="card records-card">
        <h3 style="margin-top: 0">當日轉盤記錄</h3>
        <p v-if="records.length === 0" class="muted">今日未抽過任何學生。</p>
        <ol v-else class="record-list">
          <li v-for="r in records" :key="r.id">
            <span>{{ r.seat_no }}. {{ r.name }}</span>
            <span class="muted">{{ timeOf(r.drawn_at) }}</span>
          </li>
        </ol>
      </div>
    </div>
  </div>
</template>

<style scoped>
.draw-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 280px;
  gap: 16px;
  align-items: start;
}
@media (max-width: 820px) {
  .draw-layout { grid-template-columns: minmax(0, 1fr); }
}
.wheel-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}
.wheel-wrap {
  position: relative;
  width: 100%;
  max-width: 440px;
}
.wheel {
  display: block;
  width: 100%;
  height: auto;
  filter: drop-shadow(0 4px 10px rgba(16, 24, 40, 0.15));
}
.pointer {
  position: absolute;
  top: -4px;
  left: 50%;
  transform: translateX(-50%);
  width: 0;
  height: 0;
  border-left: 16px solid transparent;
  border-right: 16px solid transparent;
  border-top: 30px solid var(--danger);
  z-index: 2;
  filter: drop-shadow(0 2px 2px rgba(0, 0, 0, 0.2));
}
.spin-btn {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 60px;
  height: 60px;
  border-radius: 50%;
  padding: 0;
  font-size: 18px;
}
.spin-btn:active { transform: translate(-50%, -50%); }
.winner {
  font-size: 22px;
  padding: 12px 20px;
  border-radius: var(--radius);
  background: var(--warn-bg);
  text-align: center;
}
.record-list {
  margin: 0;
  padding-left: 22px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.record-list li span:first-child { font-weight: 500; margin-right: 8px; }
</style>
