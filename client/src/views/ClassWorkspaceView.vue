<script setup>
import { ref, reactive, computed, watch, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import http from '../api/http';
import ScorePicker from '../components/ScorePicker.vue';
import AttendanceStatusPicker from '../components/AttendanceStatusPicker.vue';

const route = useRoute();
const csId = computed(() => route.params.id);

const info = ref(null);
const roster = ref([]);
const meta = ref({ presetScores: [100, 80, 60, 40], singleStatusOptions: [], doubleStatusOptions: [] });

const activeTab = ref('daily');
const tabs = [
  { key: 'daily', label: '今日課堂記錄' },
  { key: 'tests', label: '大測' },
  { key: 'export', label: '匯出 Excel' },
];

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// ---- 今日課堂記錄 (出席 / 表現分 / 堂課分 合併一齊填,一次過儲存) ----
const dailyDate = ref(todayStr());
const periodMode = ref('single');
const attendanceStatus = reactive({});
const performanceScores = reactive({});
const lessonScores = reactive({});
const dailyLoading = ref(false);
const dailySaving = ref(false);
const dailyMsg = ref('');
const dailyErr = ref('');

const attendanceStatusOptions = computed(() =>
  periodMode.value === 'double' ? meta.value.doubleStatusOptions : meta.value.singleStatusOptions
);

function scoreOf(status) {
  const opt = attendanceStatusOptions.value.find((o) => o.status === status);
  return opt ? opt.score : null;
}

// 出席分為 0(缺席)嘅學生,表現分/堂課分都應該跟住為 0
function isAbsent(studentId) {
  return scoreOf(attendanceStatus[studentId]) === 0;
}

// 未揀出席狀態之前,唔可以填表現分/堂課分(要先決定咗出席先可以評分)
function hasAttendance(studentId) {
  return !!attendanceStatus[studentId];
}

// 表現分/堂課分揀嘅掣係咪要鎖住:未揀出席,或者已經係缺席
function scoreLocked(studentId) {
  return !hasAttendance(studentId) || isAbsent(studentId);
}

function clearMap(map) {
  Object.keys(map).forEach((k) => delete map[k]);
}

// 出席狀態一改(包括套用全部出席),即刻將出席分為 0 嘅學生嘅表現分/堂課分都拉返做 0
watch(
  attendanceStatus,
  () => {
    for (const s of roster.value) {
      if (isAbsent(s.id)) {
        performanceScores[s.id] = 0;
        lessonScores[s.id] = 0;
      }
    }
  },
  { deep: true }
);

async function loadDaily() {
  dailyMsg.value = '';
  dailyErr.value = '';
  dailyLoading.value = true;
  try {
    const [attRes, perfRes, lessonRes] = await Promise.all([
      http.get(`/teacher/class-subjects/${csId.value}/attendance`, { params: { date: dailyDate.value } }),
      http.get(`/teacher/class-subjects/${csId.value}/performance_scores`, { params: { date: dailyDate.value } }),
      http.get(`/teacher/class-subjects/${csId.value}/lesson_scores`, { params: { date: dailyDate.value } }),
    ]);
    periodMode.value = attRes.data.periodMode || 'single';
    clearMap(attendanceStatus);
    for (const r of attRes.data.records) attendanceStatus[r.student_id] = r.status;
    clearMap(performanceScores);
    for (const r of perfRes.data.records) performanceScores[r.student_id] = r.score;
    clearMap(lessonScores);
    for (const r of lessonRes.data.records) lessonScores[r.student_id] = r.score;
  } finally {
    dailyLoading.value = false;
  }
}

watch([dailyDate, activeTab], ([, tab]) => {
  if (tab === 'daily' && csId.value) loadDaily();
});
watch(periodMode, () => clearMap(attendanceStatus));

// ---- 快速填寫 ----
const bulkAttendanceStatus = ref('');
const bulkPerformanceScore = ref(null);
const bulkLessonScore = ref(null);

function applyBulkAttendance() {
  if (!bulkAttendanceStatus.value) return;
  for (const s of roster.value) attendanceStatus[s.id] = bulkAttendanceStatus.value;
}
// 套用全部表現分/堂課分嗰陣:未揀出席狀態嘅學生跳過(唔郁佢),缺席嘅學生固定為 0,
// 淨係對已經揀咗出席、又冇缺席嘅學生套用個分數
function applyBulkPerformance() {
  if (bulkPerformanceScore.value === null || bulkPerformanceScore.value === '') return;
  for (const s of roster.value) {
    if (!hasAttendance(s.id)) continue;
    performanceScores[s.id] = isAbsent(s.id) ? 0 : Number(bulkPerformanceScore.value);
  }
}
function applyBulkLesson() {
  if (bulkLessonScore.value === null || bulkLessonScore.value === '') return;
  for (const s of roster.value) {
    if (!hasAttendance(s.id)) continue;
    lessonScores[s.id] = isAbsent(s.id) ? 0 : Number(bulkLessonScore.value);
  }
}

// ---- 儲存 (三種分數獨立判斷:淨係填咗至少一個學生嘅先會檢查/儲存,完全冇填就當日冇呢類記錄) ----
function buildCategoryPlan(map, label) {
  const touched = roster.value.filter((s) => map[s.id] !== undefined && map[s.id] !== null && map[s.id] !== '');
  if (touched.length === 0) return { skip: true };
  if (touched.length !== roster.value.length) {
    return { skip: false, error: `「${label}」仲有 ${roster.value.length - touched.length} 位學生未填` };
  }
  return { skip: false, error: null };
}

async function saveDaily() {
  dailyErr.value = '';
  dailyMsg.value = '';

  const attPlan = buildCategoryPlan(attendanceStatus, '出席狀態');
  const perfPlan = buildCategoryPlan(performanceScores, '表現分');
  const lessonPlan = buildCategoryPlan(lessonScores, '堂課分');

  const errors = [attPlan, perfPlan, lessonPlan].filter((p) => p.error).map((p) => p.error);
  if (errors.length > 0) {
    dailyErr.value = errors.join('; ');
    return;
  }
  if (attPlan.skip && perfPlan.skip && lessonPlan.skip) {
    dailyErr.value = '請至少填寫一種分數先可以儲存';
    return;
  }

  dailySaving.value = true;
  const saved = [];
  try {
    const tasks = [];
    if (!attPlan.skip) {
      const records = roster.value.map((s) => ({ studentId: s.id, status: attendanceStatus[s.id] }));
      tasks.push(
        http
          .post(`/teacher/class-subjects/${csId.value}/attendance`, { date: dailyDate.value, periodMode: periodMode.value, records })
          .then(() => saved.push('出席'))
      );
    }
    if (!perfPlan.skip) {
      const records = roster.value.map((s) => ({ studentId: s.id, score: performanceScores[s.id] }));
      tasks.push(
        http
          .post(`/teacher/class-subjects/${csId.value}/performance_scores`, { date: dailyDate.value, records })
          .then(() => saved.push('表現分'))
      );
    }
    if (!lessonPlan.skip) {
      const records = roster.value.map((s) => ({ studentId: s.id, score: lessonScores[s.id] }));
      tasks.push(
        http
          .post(`/teacher/class-subjects/${csId.value}/lesson_scores`, { date: dailyDate.value, records })
          .then(() => saved.push('堂課分'))
      );
    }
    await Promise.all(tasks);
    dailyMsg.value = `已儲存:${saved.join('、')}`;
  } catch (e) {
    dailyErr.value = e.response?.data?.error || '儲存失敗,請重試';
  } finally {
    dailySaving.value = false;
  }
}

async function deleteDaily() {
  dailyErr.value = '';
  dailyMsg.value = '';
  if (!confirm(`確定要刪除 ${dailyDate.value} 呢日嘅出席、表現分、堂課分記錄?呢個動作不可還原。`)) return;
  dailySaving.value = true;
  try {
    await http.delete(`/teacher/class-subjects/${csId.value}/daily-record`, { params: { date: dailyDate.value } });
    clearMap(attendanceStatus);
    clearMap(performanceScores);
    clearMap(lessonScores);
    dailyMsg.value = `已刪除 ${dailyDate.value} 呢日嘅記錄`;
  } catch (e) {
    dailyErr.value = e.response?.data?.error || '刪除失敗,請重試';
  } finally {
    dailySaving.value = false;
  }
}

// ---- 大測 ----
const tests = ref([]);
const testsLoading = ref(false);
const newTestName = ref('');
const newTestDate = ref(todayStr());
const selectedTestId = ref(null);
const testScores = reactive({});
const testScoresLoading = ref(false);
const testScoresSaving = ref(false);
const testMsg = ref('');
const testErr = ref('');

async function loadTests() {
  testsLoading.value = true;
  try {
    const { data } = await http.get(`/teacher/class-subjects/${csId.value}/tests`);
    tests.value = data;
  } finally {
    testsLoading.value = false;
  }
}

async function createTest() {
  testErr.value = '';
  if (!newTestName.value || !newTestDate.value) {
    testErr.value = '請輸入測驗名稱同日期';
    return;
  }
  await http.post(`/teacher/class-subjects/${csId.value}/tests`, { name: newTestName.value, date: newTestDate.value });
  newTestName.value = '';
  await loadTests();
}

async function selectTest(testId) {
  selectedTestId.value = testId;
  testMsg.value = '';
  testErr.value = '';
  testScoresLoading.value = true;
  try {
    const { data } = await http.get(`/teacher/tests/${testId}/scores`);
    clearMap(testScores);
    for (const r of data.records) testScores[r.student_id] = r.score;
  } finally {
    testScoresLoading.value = false;
  }
}

async function saveTestScores() {
  testErr.value = '';
  testMsg.value = '';
  const records = roster.value
    .filter((s) => testScores[s.id] !== undefined && testScores[s.id] !== null)
    .map((s) => ({ studentId: s.id, score: testScores[s.id] }));
  testScoresSaving.value = true;
  try {
    await http.post(`/teacher/tests/${selectedTestId.value}/scores`, { records });
    testMsg.value = '測驗分數已儲存';
  } catch (e) {
    testErr.value = e.response?.data?.error || '儲存失敗';
  } finally {
    testScoresSaving.value = false;
  }
}

watch(activeTab, (tab) => {
  if (tab === 'tests' && csId.value) loadTests();
});

const exportUrl = computed(() => `/api/teacher/class-subjects/${csId.value}/export`);

onMounted(async () => {
  // class_type(普中/職中)會影響單節出席「遲到」嘅分數,要先攞返班級資訊先可以攞啱嘅 meta
  const [infoRes, rosterRes] = await Promise.all([
    http.get(`/teacher/class-subjects/${csId.value}`),
    http.get(`/teacher/class-subjects/${csId.value}/roster`),
  ]);
  info.value = infoRes.data;
  roster.value = rosterRes.data;
  const metaRes = await http.get('/teacher/meta', { params: { classType: info.value?.class_type } });
  meta.value = metaRes.data;
  await loadDaily();
});
</script>

<template>
  <div class="page">
    <div class="row">
      <h2 style="margin: 0">{{ info?.class_name }} - {{ info?.subject_name }}</h2>
      <span class="muted" v-if="info">{{ info.class_type === 'vocational' ? '職中' : '普中' }}</span>
      <span class="muted" v-if="info?.homeroom_teacher">導師:{{ info.homeroom_teacher }}</span>
      <span class="muted">共 {{ roster.length }} 位學生</span>
    </div>

    <div class="tabs">
      <button v-for="t in tabs" :key="t.key" :class="{ active: activeTab === t.key }" @click="activeTab = t.key">
        {{ t.label }}
      </button>
    </div>

    <!-- 今日課堂記錄:出席 / 表現分 / 堂課分 合併一齊填 -->
    <div v-if="activeTab === 'daily'" class="card" style="display: flex; flex-direction: column; gap: 14px">
      <div class="row">
        <label class="field-group">
          <span class="label">日期</span>
          <input type="date" v-model="dailyDate" />
        </label>
        <label class="field-group">
          <span class="label">堂數</span>
          <select v-model="periodMode">
            <option value="single">單課</option>
            <option value="double">連續兩節</option>
          </select>
        </label>
        <div class="spacer" />
        <button class="danger" :disabled="dailySaving || dailyLoading" @click="deleteDaily">刪除呢日記錄</button>
        <button class="primary" :disabled="dailySaving || dailyLoading" @click="saveDaily">
          {{ dailySaving ? '儲存中...' : '儲存全部記錄' }}
        </button>
      </div>

      <div class="toolbar">
        <span class="label" style="font-weight: 600; color: var(--text)">快速填寫:</span>
        <div class="field-group">
          <select v-model="bulkAttendanceStatus" style="min-width: 150px">
            <option value="" disabled>出席狀態</option>
            <option v-for="opt in attendanceStatusOptions" :key="opt.status" :value="opt.status">{{ opt.label }}</option>
          </select>
          <button class="sm" @click="applyBulkAttendance">套用全部出席</button>
        </div>
        <div class="divider" />
        <div class="field-group">
          <input type="number" min="0" max="100" placeholder="表現分" v-model="bulkPerformanceScore" style="width: 80px" />
          <button class="sm" @click="applyBulkPerformance">套用全部表現分</button>
        </div>
        <div class="divider" />
        <div class="field-group">
          <input type="number" min="0" max="100" placeholder="堂課分" v-model="bulkLessonScore" style="width: 80px" />
          <button class="sm" @click="applyBulkLesson">套用全部堂課分</button>
        </div>
      </div>

      <div v-if="dailyErr" class="error-box">{{ dailyErr }}</div>
      <div v-if="dailyMsg" class="success-box">{{ dailyMsg }}</div>

      <p v-if="dailyLoading" class="muted">載入緊...</p>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>學號</th>
              <th style="text-align: left">姓名</th>
              <th>出席狀態</th>
              <th>出席分</th>
              <th>表現分</th>
              <th>堂課分</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in roster" :key="s.id">
              <td>{{ s.seat_no }}</td>
              <td class="name-cell">{{ s.name }}</td>
              <td>
                <AttendanceStatusPicker v-model="attendanceStatus[s.id]" :options="attendanceStatusOptions" />
              </td>
              <td>{{ attendanceStatus[s.id] ? scoreOf(attendanceStatus[s.id]) : '-' }}</td>
              <td><ScorePicker v-model="performanceScores[s.id]" :presets="meta.presetScores" :disabled="scoreLocked(s.id)" /></td>
              <td><ScorePicker v-model="lessonScores[s.id]" :presets="meta.presetScores" :disabled="scoreLocked(s.id)" /></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 大測 -->
    <div v-else-if="activeTab === 'tests'" class="card">
      <div class="row" style="margin-bottom: 12px">
        <input v-model="newTestName" placeholder="測驗名稱" />
        <input type="date" v-model="newTestDate" />
        <button class="primary" @click="createTest">新增測驗</button>
      </div>
      <div v-if="testErr" class="error-box">{{ testErr }}</div>

      <p v-if="testsLoading" class="muted">載入緊...</p>
      <div v-else class="row" style="margin-bottom: 12px; flex-wrap: wrap">
        <button
          v-for="t in tests"
          :key="t.id"
          :class="{ primary: selectedTestId === t.id }"
          @click="selectTest(t.id)"
        >
          {{ t.name }} ({{ t.date }})
        </button>
        <span v-if="tests.length === 0" class="muted">未有測驗,請先新增</span>
      </div>

      <template v-if="selectedTestId">
        <div v-if="testMsg" class="success-box" style="margin-bottom: 8px">{{ testMsg }}</div>
        <p v-if="testScoresLoading" class="muted">載入緊...</p>
        <div v-else class="table-wrap">
          <table>
            <thead><tr><th>學號</th><th style="text-align: left">姓名</th><th>分數</th></tr></thead>
            <tbody>
              <tr v-for="s in roster" :key="s.id">
                <td>{{ s.seat_no }}</td>
                <td class="name-cell">{{ s.name }}</td>
                <td><ScorePicker v-model="testScores[s.id]" :presets="meta.presetScores" /></td>
              </tr>
            </tbody>
          </table>
        </div>
        <button class="primary" style="margin-top: 12px" :disabled="testScoresSaving" @click="saveTestScores">
          儲存測驗分數
        </button>
      </template>
    </div>

    <!-- 匯出 -->
    <div v-else-if="activeTab === 'export'" class="card">
      <p>匯出呢個班級/科目嘅完整點名及評分表,格式同學校原本嘅「交分」範本一致,可以直接交比科組。</p>
      <a :href="exportUrl">
        <button class="primary">匯出 Excel</button>
      </a>
    </div>
  </div>
</template>
