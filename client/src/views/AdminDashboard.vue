<script setup>
import { ref, reactive, onMounted } from 'vue';
import http from '../api/http';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const section = ref('classSubjects');
const sections = [
  { key: 'classSubjects', label: '班級 / 科目 / 指派' },
  { key: 'users', label: '用戶管理' },
  { key: 'records', label: '查看記錄' },
];

// ---- 基礎資料 ----
const classes = ref([]);
const subjects = ref([]);
const teachers = ref([]);
const classSubjects = ref([]);

async function reloadAll() {
  const [c, s, u, cs] = await Promise.all([
    http.get('/admin/classes'),
    http.get('/admin/subjects'),
    http.get('/admin/users'),
    http.get('/admin/class-subjects'),
  ]);
  classes.value = c.data;
  subjects.value = s.data;
  teachers.value = u.data.filter((x) => x.role === 'teacher');
  classSubjects.value = cs.data;
}
onMounted(reloadAll);

// ---- 班級 ----
const newClassName = ref('');
const newClassType = ref('general');
const classErr = ref('');
async function createClass() {
  classErr.value = '';
  if (!newClassName.value) return;
  try {
    await http.post('/admin/classes', { name: newClassName.value, classType: newClassType.value });
    newClassName.value = '';
    newClassType.value = 'general';
    await reloadAll();
  } catch (e) {
    classErr.value = e.response?.data?.error || '新增失敗';
  }
}

const classTypeSaving = reactive({});
async function updateClassType(cls) {
  classTypeSaving[cls.id] = true;
  try {
    await http.put(`/admin/classes/${cls.id}`, { classType: cls.class_type });
  } finally {
    classTypeSaving[cls.id] = false;
  }
}

const rosterFiles = reactive({});
const rosterMsg = reactive({});
async function uploadRoster(classId, event) {
  const file = event.target.files[0];
  if (!file) return;
  const form = new FormData();
  form.append('file', file);
  try {
    const { data } = await http.post(`/admin/classes/${classId}/roster`, form);
    rosterMsg[classId] = `已匯入 ${data.imported} 位學生`;
    if (expandedClassId.value === classId) await loadClassStudents(classId);
  } catch (e) {
    rosterMsg[classId] = e.response?.data?.error || '匯入失敗';
  }
  event.target.value = '';
}

async function deleteClass(cls) {
  if (!confirm(`確定要刪除班級「${cls.name}」?\n呢個動作會永久刪除呢個班嘅花名冊、指派、同所有出席/評分/測驗記錄,不可還原。`)) return;
  await http.delete(`/admin/classes/${cls.id}`);
  if (expandedClassId.value === cls.id) expandedClassId.value = '';
  await reloadAll();
}

// ---- 批量匯入花名冊 (一個 Excel 多個工作表,工作表名 = 班級名) ----
const batchImportResult = ref(null);
const batchImportErr = ref('');
const batchImporting = ref(false);
async function uploadRosterBatch(event) {
  const file = event.target.files[0];
  if (!file) return;
  batchImportErr.value = '';
  batchImportResult.value = null;
  batchImporting.value = true;
  const form = new FormData();
  form.append('file', file);
  try {
    const { data } = await http.post('/admin/classes/roster-batch-import', form);
    batchImportResult.value = data;
    await reloadAll();
  } catch (e) {
    batchImportErr.value = e.response?.data?.error || '批量匯入失敗';
  } finally {
    batchImporting.value = false;
  }
  event.target.value = '';
}

// ---- 班級展開:查看 / 刪除學生 ----
const expandedClassId = ref('');
const classStudents = reactive({});
const classStudentsLoading = ref(false);
async function toggleClassStudents(classId) {
  if (expandedClassId.value === classId) {
    expandedClassId.value = '';
    return;
  }
  expandedClassId.value = classId;
  await loadClassStudents(classId);
}
async function loadClassStudents(classId) {
  classStudentsLoading.value = true;
  try {
    const { data } = await http.get(`/admin/classes/${classId}/students`);
    classStudents[classId] = data;
  } finally {
    classStudentsLoading.value = false;
  }
}
async function deleteStudent(classId, student) {
  if (!confirm(`確定要刪除學生「${student.name}」?歷史出席/評分記錄會保留,但唔會再喺花名冊/匯出出現。`)) return;
  await http.delete(`/admin/classes/${classId}/students/${student.id}`);
  await loadClassStudents(classId);
}

// ---- 科目 ----
const newSubjectName = ref('');
const subjectErr = ref('');
async function createSubject() {
  subjectErr.value = '';
  if (!newSubjectName.value) return;
  try {
    await http.post('/admin/subjects', { name: newSubjectName.value });
    newSubjectName.value = '';
    await reloadAll();
  } catch (e) {
    subjectErr.value = e.response?.data?.error || '新增失敗';
  }
}
async function deleteSubject(subject) {
  if (!confirm(`確定要刪除科目「${subject.name}」?呢個動作會一併刪除用到呢個科目嘅班級指派同相關記錄,不可還原。`)) return;
  await http.delete(`/admin/subjects/${subject.id}`);
  await reloadAll();
}

// ---- 班級 x 科目 指派 ----
const newAssign = reactive({ classId: '', subjectId: '', teacherId: '', homeroomTeacher: '' });
const assignErr = ref('');
async function createAssignment() {
  assignErr.value = '';
  if (!newAssign.classId || !newAssign.subjectId) {
    assignErr.value = '請選擇班級同科目';
    return;
  }
  try {
    await http.post('/admin/class-subjects', { ...newAssign });
    newAssign.classId = '';
    newAssign.subjectId = '';
    newAssign.teacherId = '';
    newAssign.homeroomTeacher = '';
    await reloadAll();
  } catch (e) {
    assignErr.value = e.response?.data?.error || '新增失敗';
  }
}
async function updateAssignment(cs) {
  await http.put(`/admin/class-subjects/${cs.id}`, { teacherId: cs.teacher_id, homeroomTeacher: cs.homeroom_teacher });
}
async function deleteAssignment(cs) {
  if (!confirm(`確定要刪除「${cs.class_name} - ${cs.subject_name}」呢個指派?呢個動作會一併刪除底下所有出席/評分/測驗記錄,不可還原。`)) return;
  await http.delete(`/admin/class-subjects/${cs.id}`);
  await reloadAll();
}

// ---- 用戶 ----
const users = ref([]);
async function loadUsers() {
  const { data } = await http.get('/admin/users');
  users.value = data;
}
onMounted(loadUsers);

const newUser = reactive({ username: '', password: '', displayName: '', role: 'teacher' });
const userErr = ref('');
async function createUser() {
  userErr.value = '';
  if (!newUser.username || !newUser.password || !newUser.displayName) {
    userErr.value = '請填寫所有欄位';
    return;
  }
  try {
    await http.post('/admin/users', { ...newUser });
    newUser.username = '';
    newUser.password = '';
    newUser.displayName = '';
    newUser.role = 'teacher';
    await Promise.all([loadUsers(), reloadAll()]);
  } catch (e) {
    userErr.value = e.response?.data?.error || '新增失敗';
  }
}

const resetPasswordValue = reactive({});
const resetMsg = reactive({});
async function resetPassword(userId) {
  const pw = resetPasswordValue[userId];
  if (!pw || pw.length < 6) {
    resetMsg[userId] = '新密碼最少 6 個字元';
    return;
  }
  await http.post(`/admin/users/${userId}/reset-password`, { newPassword: pw });
  resetMsg[userId] = '已重設密碼';
  resetPasswordValue[userId] = '';
}

const deleteUserErr = ref('');
async function deleteUser(u) {
  deleteUserErr.value = '';
  if (!confirm(`確定要刪除用戶「${u.display_name}(${u.username})」?歷史出席/評分/測驗記錄會保留,但會失去登入權限,不可還原。`)) return;
  try {
    await http.delete(`/admin/users/${u.id}`);
    await loadUsers();
  } catch (e) {
    deleteUserErr.value = e.response?.data?.error || '刪除失敗';
  }
}

// ---- 記錄查看 ----
const selectedRecordCsId = ref('');
const recordData = ref(null);
const recordLoading = ref(false);
async function loadRecords() {
  if (!selectedRecordCsId.value) return;
  recordLoading.value = true;
  try {
    const { data } = await http.get(`/admin/class-subjects/${selectedRecordCsId.value}/records`);
    recordData.value = data;
  } finally {
    recordLoading.value = false;
  }
}
</script>

<template>
  <div class="page">
    <h2>管理後台</h2>
    <div class="tabs">
      <button v-for="s in sections" :key="s.key" :class="{ active: section === s.key }" @click="section = s.key">
        {{ s.label }}
      </button>
    </div>

    <!-- 班級 / 科目 / 指派 -->
    <template v-if="section === 'classSubjects'">
      <div class="card">
        <h3 style="margin-top: 0">班級</h3>
        <div class="row">
          <input v-model="newClassName" placeholder="新班級名稱,例如 F2A(菁)" />
          <select v-model="newClassType">
            <option value="general">普中</option>
            <option value="vocational">職中</option>
          </select>
          <button class="primary" @click="createClass">新增班級</button>
        </div>
        <div v-if="classErr" class="error-box" style="margin-top: 8px">{{ classErr }}</div>

        <div class="toolbar" style="margin-top: 12px">
          <span class="label" style="font-weight: 600; color: var(--text)">批量匯入花名冊:</span>
          <span class="muted">一個 Excel 入面可以有多個工作表,工作表名 = 班級名(冇嗰個班會自動新建)</span>
          <div class="spacer" />
          <input type="file" accept=".xlsx" :disabled="batchImporting" @change="uploadRosterBatch" />
        </div>
        <div v-if="batchImportErr" class="error-box" style="margin-top: 8px">{{ batchImportErr }}</div>
        <div v-if="batchImportResult" class="success-box" style="margin-top: 8px">
          <div v-for="i in batchImportResult.imported" :key="'i' + i.className">
            ✓ {{ i.className }}{{ i.created ? '(新班級)' : '' }}:匯入 {{ i.count }} 位學生
          </div>
          <div v-for="s in batchImportResult.skipped" :key="'s' + s.sheetName" style="color: var(--danger)">
            ✗ {{ s.sheetName || '(未命名工作表)' }}:{{ s.reason }}
          </div>
        </div>

        <div class="table-wrap" style="margin-top: 12px">
          <table>
            <thead><tr><th style="text-align: left">班級</th><th>類型</th><th>上傳花名冊 (Excel)</th><th>結果</th><th>學生</th><th></th></tr></thead>
            <tbody>
              <template v-for="c in classes" :key="c.id">
                <tr>
                  <td class="name-cell">{{ c.name }}</td>
                  <td>
                    <select v-model="c.class_type" :disabled="classTypeSaving[c.id]" @change="updateClassType(c)">
                      <option value="general">普中</option>
                      <option value="vocational">職中</option>
                    </select>
                  </td>
                  <td><input type="file" accept=".xlsx" @change="(e) => uploadRoster(c.id, e)" /></td>
                  <td class="muted">{{ rosterMsg[c.id] || '' }}</td>
                  <td><button class="sm" @click="toggleClassStudents(c.id)">{{ expandedClassId === c.id ? '收起' : '查看/刪除' }}</button></td>
                  <td><button class="sm danger" @click="deleteClass(c)">刪除班級</button></td>
                </tr>
                <tr v-if="expandedClassId === c.id">
                  <td colspan="6" style="text-align: left; background: #fafbfd">
                    <p v-if="classStudentsLoading" class="muted">載入緊...</p>
                    <p v-else-if="!classStudents[c.id] || classStudents[c.id].length === 0" class="muted">呢個班未有學生。</p>
                    <div v-else class="row" style="flex-wrap: wrap; gap: 8px">
                      <span v-for="st in classStudents[c.id]" :key="st.id" class="badge ok" style="gap: 8px">
                        {{ st.seat_no }}. {{ st.name }}
                        <button class="ghost sm" style="padding: 0 2px" title="刪除學生" @click="deleteStudent(c.id, st)">✕</button>
                      </span>
                    </div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <h3 style="margin-top: 0">科目</h3>
        <div class="row">
          <input v-model="newSubjectName" placeholder="新科目名稱,例如 數學" />
          <button class="primary" @click="createSubject">新增科目</button>
        </div>
        <div v-if="subjectErr" class="error-box" style="margin-top: 8px">{{ subjectErr }}</div>
        <div class="row" style="margin-top: 8px; flex-wrap: wrap">
          <span v-for="s in subjects" :key="s.id" class="badge ok" style="gap: 8px">
            {{ s.name }}
            <button class="ghost sm" style="padding: 0 2px" title="刪除科目" @click="deleteSubject(s)">✕</button>
          </span>
        </div>
      </div>

      <div class="card">
        <h3 style="margin-top: 0">班級 x 科目 指派老師</h3>
        <div class="row">
          <select v-model="newAssign.classId">
            <option value="" disabled>選擇班級</option>
            <option v-for="c in classes" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
          <select v-model="newAssign.subjectId">
            <option value="" disabled>選擇科目</option>
            <option v-for="s in subjects" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
          <select v-model="newAssign.teacherId">
            <option value="">未指派老師</option>
            <option v-for="t in teachers" :key="t.id" :value="t.id">{{ t.display_name }}</option>
          </select>
          <input v-model="newAssign.homeroomTeacher" placeholder="導師姓名(選填)" />
          <button class="primary" @click="createAssignment">新增指派</button>
        </div>
        <div v-if="assignErr" class="error-box" style="margin-top: 8px">{{ assignErr }}</div>

        <div class="table-wrap" style="margin-top: 12px">
          <table>
            <thead><tr><th>班級</th><th>科目</th><th>任教老師</th><th>導師</th><th></th><th></th></tr></thead>
            <tbody>
              <tr v-for="cs in classSubjects" :key="cs.id">
                <td>{{ cs.class_name }}</td>
                <td>{{ cs.subject_name }}</td>
                <td>
                  <select v-model="cs.teacher_id" @change="updateAssignment(cs)">
                    <option :value="null">未指派</option>
                    <option v-for="t in teachers" :key="t.id" :value="t.id">{{ t.display_name }}</option>
                  </select>
                </td>
                <td><input v-model="cs.homeroom_teacher" @change="updateAssignment(cs)" style="width: 90px" /></td>
                <td>
                  <a :href="`/api/admin/class-subjects/${cs.id}/export`">
                    <button class="sm">匯出</button>
                  </a>
                </td>
                <td><button class="sm danger" @click="deleteAssignment(cs)">刪除</button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- 用戶管理 -->
    <template v-else-if="section === 'users'">
      <div class="card">
        <h3 style="margin-top: 0">新增用戶</h3>
        <div class="row">
          <input v-model="newUser.username" placeholder="帳號" />
          <input v-model="newUser.password" placeholder="密碼" type="password" />
          <input v-model="newUser.displayName" placeholder="顯示名稱" />
          <select v-model="newUser.role">
            <option value="teacher">老師</option>
            <option value="admin">管理員</option>
          </select>
          <button class="primary" @click="createUser">新增</button>
        </div>
        <div v-if="userErr" class="error-box" style="margin-top: 8px">{{ userErr }}</div>
      </div>

      <div class="card">
        <h3 style="margin-top: 0">用戶列表</h3>
        <div v-if="deleteUserErr" class="error-box" style="margin-bottom: 8px">{{ deleteUserErr }}</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>帳號</th><th>名稱</th><th>角色</th><th>重設密碼</th><th></th></tr></thead>
            <tbody>
              <tr v-for="u in users" :key="u.id">
                <td>{{ u.username }}</td>
                <td>{{ u.display_name }}</td>
                <td>{{ u.role === 'admin' ? '管理員' : '老師' }}</td>
                <td>
                  <div class="row" style="justify-content: center">
                    <input v-model="resetPasswordValue[u.id]" placeholder="新密碼" type="password" style="width: 100px" />
                    <button class="sm" @click="resetPassword(u.id)">重設</button>
                    <span class="muted">{{ resetMsg[u.id] || '' }}</span>
                  </div>
                </td>
                <td>
                  <button v-if="u.id !== auth.user?.id" class="sm danger" @click="deleteUser(u)">刪除</button>
                  <span v-else class="muted">(目前登入)</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- 記錄查看 -->
    <template v-else-if="section === 'records'">
      <div class="card">
        <div class="row">
          <select v-model="selectedRecordCsId" @change="loadRecords">
            <option value="" disabled>選擇班級 / 科目</option>
            <option v-for="cs in classSubjects" :key="cs.id" :value="cs.id">
              {{ cs.class_name }} - {{ cs.subject_name }}
            </option>
          </select>
          <a v-if="selectedRecordCsId" :href="`/api/admin/class-subjects/${selectedRecordCsId}/export`">
            <button class="primary">匯出 Excel</button>
          </a>
        </div>

        <p v-if="recordLoading" class="muted" style="margin-top: 12px">載入緊...</p>
        <div v-else-if="recordData" style="overflow-x: auto; margin-top: 12px">
          <table>
            <thead>
              <tr>
                <th>學號</th>
                <th>姓名</th>
                <th v-for="d in recordData.dates" :key="'a' + d">出席 {{ d }}</th>
                <th v-for="d in recordData.dates" :key="'p' + d">表現 {{ d }}</th>
                <th v-for="d in recordData.dates" :key="'l' + d">堂課 {{ d }}</th>
                <th v-for="t in recordData.tests" :key="'t' + t.id">{{ t.name }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in recordData.students" :key="s.id">
                <td>{{ s.seatNo }}</td>
                <td>{{ s.name }}</td>
                <td v-for="d in recordData.dates" :key="'a' + d">{{ recordData.attendance[d]?.[s.id] ?? '' }}</td>
                <td v-for="d in recordData.dates" :key="'p' + d">{{ recordData.performance[d]?.[s.id] ?? '' }}</td>
                <td v-for="d in recordData.dates" :key="'l' + d">{{ recordData.lessonScore[d]?.[s.id] ?? '' }}</td>
                <td v-for="t in recordData.tests" :key="'t' + t.id">{{ t.scores[s.id] ?? '' }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="recordData.students.length === 0" class="muted">呢個班級未有花名冊,請先上傳。</p>
          <p v-if="recordData.dates.length === 0 && recordData.tests.length === 0" class="muted">呢個班級/科目暫時未有任何記錄。</p>
        </div>
      </div>
    </template>
  </div>
</template>
