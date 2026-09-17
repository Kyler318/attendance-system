const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { parseRosterBuffer, parseRosterWorkbookSheets, buildClassExportWorkbook } = require('../utils/excel');
const { gatherClassExportData } = require('../utils/exportData');
const { normalizeClassType } = require('../utils/scoring');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.use(authenticate, requireRole('admin'));

// 統一錯誤處理:所有 handler 都係 async,錯誤會經 next(err) 落去 index.js 嘅 error middleware
function h(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

// ---- 用戶管理 ----
router.get(
  '/users',
  h(async (req, res) => {
    const users = await db
      .prepare('SELECT id, username, role, display_name, must_change_password, created_at FROM users ORDER BY id')
      .all();
    res.json(users);
  })
);

router.post(
  '/users',
  h(async (req, res) => {
    const { username, password, displayName, role } = req.body || {};
    if (!username || !password || !displayName || !['admin', 'teacher'].includes(role)) {
      return res.status(400).json({ error: '欄位不完整' });
    }
    const exists = await db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (exists) return res.status(409).json({ error: '帳號已存在' });
    const hash = bcrypt.hashSync(password, 10);
    const info = await db
      .prepare(
        'INSERT INTO users (username, password_hash, role, display_name, must_change_password) VALUES (?,?,?,?,1) RETURNING id'
      )
      .run(username, hash, role, displayName);
    res.status(201).json({ id: info.lastInsertRowid });
  })
);

router.post(
  '/users/:id/reset-password',
  h(async (req, res) => {
    const { newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: '新密碼最少 6 個字元' });
    const hash = bcrypt.hashSync(newPassword, 10);
    await db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hash, req.params.id);
    res.json({ ok: true });
  })
);

// 刪除用戶(老師或管理員帳號)—— 保留歷史出席/評分/測驗記錄,只係將「邊個做嘅」呢個關聯清空,
// 唔會累到過往記錄一齊不見咗;班級 x 科目嘅任教老師會自動變返「未指派」
router.delete(
  '/users/:id',
  h(async (req, res) => {
    const target = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!target) return res.status(404).json({ error: '搵唔到用戶' });
    if (String(target.id) === String(req.user.id)) return res.status(400).json({ error: '唔可以刪除自己而家登入緊嘅帳號' });
    if (target.role === 'admin') {
      const row = await db.prepare("SELECT COUNT(*)::int AS c FROM users WHERE role = 'admin'").get();
      if (row.c <= 1) return res.status(400).json({ error: '最少要保留一個管理員帳號' });
    }
    const tx = db.transaction(async () => {
      await db.prepare('UPDATE lesson_sessions SET created_by = NULL WHERE created_by = ?').run(target.id);
      await db.prepare('UPDATE performance_scores SET updated_by = NULL WHERE updated_by = ?').run(target.id);
      await db.prepare('UPDATE lesson_scores SET updated_by = NULL WHERE updated_by = ?').run(target.id);
      await db.prepare('UPDATE tests SET created_by = NULL WHERE created_by = ?').run(target.id);
      await db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
    });
    await tx();
    res.json({ ok: true });
  })
);

// ---- 班級 ----
router.get(
  '/classes',
  h(async (req, res) => {
    res.json(await db.prepare('SELECT * FROM classes ORDER BY id').all());
  })
);

router.post(
  '/classes',
  h(async (req, res) => {
    const { name, classType } = req.body || {};
    if (!name) return res.status(400).json({ error: '請輸入班級名稱' });
    try {
      const info = await db
        .prepare('INSERT INTO classes (name, class_type) VALUES (?,?) RETURNING id')
        .run(name, normalizeClassType(classType));
      res.status(201).json({ id: info.lastInsertRowid, name });
    } catch (e) {
      res.status(409).json({ error: '班級名稱已存在' });
    }
  })
);

// 更改班級名稱 / 類型(普中 general / 職中 vocational —— 影響單節出席「遲到」嘅計分)
router.put(
  '/classes/:id',
  h(async (req, res) => {
    const { name, classType } = req.body || {};
    const cls = await db.prepare('SELECT * FROM classes WHERE id = ?').get(req.params.id);
    if (!cls) return res.status(404).json({ error: '搵唔到班級' });
    try {
      await db
        .prepare('UPDATE classes SET name = ?, class_type = ? WHERE id = ?')
        .run(name || cls.name, classType ? normalizeClassType(classType) : cls.class_type, req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(409).json({ error: '班級名稱已存在' });
    }
  })
);

// 刪除班級 —— 會一併刪除呢個班嘅花名冊、指派、同所有出席/評分/測驗記錄,不可還原
router.delete(
  '/classes/:id',
  h(async (req, res) => {
    const cls = await db.prepare('SELECT * FROM classes WHERE id = ?').get(req.params.id);
    if (!cls) return res.status(404).json({ error: '搵唔到班級' });
    await db.prepare('DELETE FROM classes WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  })
);

// 批量匯入花名冊:一個 Excel 入面可以有多個工作表,每個工作表名對應一個班級名,
// 名叫嗰個班存在就匯入,唔存在就自動新建班級
router.post(
  '/classes/roster-batch-import',
  upload.single('file'),
  h(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: '請上傳 Excel 檔案' });

    let sheets;
    try {
      sheets = await parseRosterWorkbookSheets(req.file.buffer);
    } catch (e) {
      return res.status(400).json({ error: `Excel 格式錯誤: ${e.message}` });
    }

    const findClass = db.prepare('SELECT * FROM classes WHERE name = ?');
    const insertClass = db.prepare('INSERT INTO classes (name) VALUES (?) RETURNING id');
    const insertStudent = db.prepare(
      'INSERT INTO students (class_id, seat_no, name) VALUES (?,?,?) ON CONFLICT(class_id, seat_no) DO UPDATE SET name = excluded.name, active = 1'
    );

    const imported = [];
    const skipped = [];
    const tx = db.transaction(async () => {
      for (const sheet of sheets) {
        if (!sheet.className) {
          skipped.push({ sheetName: sheet.className, reason: '工作表名稱空白' });
          continue;
        }
        if (sheet.students.length === 0) {
          skipped.push({ sheetName: sheet.className, reason: '喺 B 欄(第 5 行開始)搵唔到任何學生姓名' });
          continue;
        }
        let cls = await findClass.get(sheet.className);
        const created = !cls;
        if (!cls) {
          const info = await insertClass.run(sheet.className);
          cls = { id: info.lastInsertRowid, name: sheet.className };
        }
        for (const s of sheet.students) await insertStudent.run(cls.id, s.seatNo, s.name);
        imported.push({ className: sheet.className, count: sheet.students.length, created });
      }
    });
    await tx();

    res.json({ imported, skipped });
  })
);

router.post(
  '/classes/:id/roster',
  upload.single('file'),
  h(async (req, res) => {
    const classId = Number(req.params.id);
    const cls = await db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
    if (!cls) return res.status(404).json({ error: '搵唔到班級' });
    if (!req.file) return res.status(400).json({ error: '請上傳 Excel 檔案' });

    let students;
    try {
      students = await parseRosterBuffer(req.file.buffer);
    } catch (e) {
      return res.status(400).json({ error: `Excel 格式錯誤: ${e.message}` });
    }

    const insert = db.prepare(
      'INSERT INTO students (class_id, seat_no, name) VALUES (?,?,?) ON CONFLICT(class_id, seat_no) DO UPDATE SET name = excluded.name, active = 1'
    );
    const tx = db.transaction(async (rows) => {
      for (const s of rows) await insert.run(classId, s.seatNo, s.name);
    });
    await tx(students);

    res.json({ imported: students.length });
  })
);

router.get(
  '/classes/:id/students',
  h(async (req, res) => {
    const rows = await db.prepare('SELECT * FROM students WHERE class_id = ? AND active = 1 ORDER BY seat_no').all(req.params.id);
    res.json(rows);
  })
);

// 單獨新增一個學生(例如填返上傳花名冊時跳過咗嘅空白學號,或者中途插班)。
// 冇填學號就自動攞返嗰班而家最大學號 + 1;學號已經有人用嘅話(包括之前已刪除嗰啲)會
// 覆蓋埋個名同重新啟用,同上傳花名冊嗰種 upsert 行為一致
router.post(
  '/classes/:id/students',
  h(async (req, res) => {
    const cls = await db.prepare('SELECT * FROM classes WHERE id = ?').get(req.params.id);
    if (!cls) return res.status(404).json({ error: '搵唔到班級' });

    const name = (req.body?.name || '').toString().trim();
    if (!name) return res.status(400).json({ error: '請輸入學生姓名' });

    let seatNo = req.body?.seatNo === undefined || req.body?.seatNo === '' ? null : Number(req.body.seatNo);
    if (seatNo !== null && (!Number.isInteger(seatNo) || seatNo <= 0)) {
      return res.status(400).json({ error: '學號必須係正整數' });
    }
    if (seatNo === null) {
      const row = await db.prepare('SELECT COALESCE(MAX(seat_no), 0) AS m FROM students WHERE class_id = ?').get(req.params.id);
      seatNo = row.m + 1;
    }

    const info = await db
      .prepare(
        'INSERT INTO students (class_id, seat_no, name) VALUES (?,?,?) ON CONFLICT(class_id, seat_no) DO UPDATE SET name = excluded.name, active = 1 RETURNING id'
      )
      .run(req.params.id, seatNo, name);
    res.status(201).json({ id: info.lastInsertRowid, seatNo, name });
  })
);

// 刪除學生 —— 軟刪除(active=0),歷史出席/評分記錄會保留,唔會喺花名冊/匯出再出現
router.delete(
  '/classes/:classId/students/:studentId',
  h(async (req, res) => {
    const student = await db
      .prepare('SELECT * FROM students WHERE id = ? AND class_id = ?')
      .get(req.params.studentId, req.params.classId);
    if (!student) return res.status(404).json({ error: '搵唔到學生' });
    await db.prepare('UPDATE students SET active = 0 WHERE id = ?').run(student.id);
    res.json({ ok: true });
  })
);

// ---- 科目 ----
router.get(
  '/subjects',
  h(async (req, res) => {
    res.json(await db.prepare('SELECT * FROM subjects ORDER BY id').all());
  })
);

router.post(
  '/subjects',
  h(async (req, res) => {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: '請輸入科目名稱' });
    try {
      const info = await db.prepare('INSERT INTO subjects (name) VALUES (?) RETURNING id').run(name);
      res.status(201).json({ id: info.lastInsertRowid, name });
    } catch (e) {
      res.status(409).json({ error: '科目名稱已存在' });
    }
  })
);

// 刪除科目 —— 會一併刪除用到呢個科目嘅班級指派同相關記錄,不可還原
router.delete(
  '/subjects/:id',
  h(async (req, res) => {
    const subject = await db.prepare('SELECT * FROM subjects WHERE id = ?').get(req.params.id);
    if (!subject) return res.status(404).json({ error: '搵唔到科目' });
    await db.prepare('DELETE FROM subjects WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  })
);

// ---- 班級 x 科目 指派 ----
router.get(
  '/class-subjects',
  h(async (req, res) => {
    const rows = await db
      .prepare(
        `SELECT cs.id, cs.homeroom_teacher, c.id AS class_id, c.name AS class_name,
              s.id AS subject_id, s.name AS subject_name,
              u.id AS teacher_id, u.display_name AS teacher_name
       FROM class_subjects cs
       JOIN classes c ON c.id = cs.class_id
       JOIN subjects s ON s.id = cs.subject_id
       LEFT JOIN users u ON u.id = cs.teacher_id
       ORDER BY cs.id`
      )
      .all();
    res.json(rows);
  })
);

router.post(
  '/class-subjects',
  h(async (req, res) => {
    const { classId, subjectId, teacherId, homeroomTeacher } = req.body || {};
    if (!classId || !subjectId) return res.status(400).json({ error: '請選擇班級同科目' });
    try {
      const info = await db
        .prepare('INSERT INTO class_subjects (class_id, subject_id, teacher_id, homeroom_teacher) VALUES (?,?,?,?) RETURNING id')
        .run(classId, subjectId, teacherId || null, homeroomTeacher || '');
      res.status(201).json({ id: info.lastInsertRowid });
    } catch (e) {
      res.status(409).json({ error: '呢個班級已經有呢一科嘅指派' });
    }
  })
);

router.put(
  '/class-subjects/:id',
  h(async (req, res) => {
    const { teacherId, homeroomTeacher } = req.body || {};
    const cs = await db.prepare('SELECT * FROM class_subjects WHERE id = ?').get(req.params.id);
    if (!cs) return res.status(404).json({ error: '搵唔到記錄' });
    await db
      .prepare('UPDATE class_subjects SET teacher_id = ?, homeroom_teacher = ? WHERE id = ?')
      .run(teacherId || null, homeroomTeacher ?? cs.homeroom_teacher, req.params.id);
    res.json({ ok: true });
  })
);

// 刪除「班級 x 科目」指派 —— 會一併刪除呢個指派底下嘅出席/評分/測驗記錄,不可還原
router.delete(
  '/class-subjects/:id',
  h(async (req, res) => {
    const cs = await db.prepare('SELECT * FROM class_subjects WHERE id = ?').get(req.params.id);
    if (!cs) return res.status(404).json({ error: '搵唔到記錄' });
    await db.prepare('DELETE FROM class_subjects WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  })
);

// ---- 查看記錄 / 匯出 (admin 可查看任何班級,重用 teacher 邏輯) ----
router.get(
  '/class-subjects/:id/records',
  h(async (req, res) => {
    const cs = await db.prepare('SELECT * FROM class_subjects WHERE id = ?').get(req.params.id);
    if (!cs) return res.status(404).json({ error: '搵唔到記錄' });
    const data = await gatherClassExportData(cs);
    const mapToObj = (map) => {
      const out = {};
      for (const [date, inner] of map.entries()) out[date] = Object.fromEntries(inner.entries());
      return out;
    };
    res.json({
      className: data.className,
      subjectName: data.subjectName,
      homeroomTeacher: data.homeroomTeacher,
      students: data.students,
      dates: data.dates,
      attendance: mapToObj(data.attendanceMap),
      performance: mapToObj(data.performanceMap),
      lessonScore: mapToObj(data.lessonScoreMap),
      tests: data.tests.map((t) => ({ id: t.id, name: t.name, date: t.date, scores: Object.fromEntries(t.scores.entries()) })),
    });
  })
);

router.get(
  '/class-subjects/:id/export',
  h(async (req, res) => {
    const cs = await db.prepare('SELECT * FROM class_subjects WHERE id = ?').get(req.params.id);
    if (!cs) return res.status(404).json({ error: '搵唔到記錄' });
    const exportData = await gatherClassExportData(cs);
    const workbook = await buildClassExportWorkbook(exportData);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="export.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  })
);

module.exports = router;
