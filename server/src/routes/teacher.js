const express = require('express');
const db = require('../db');
const { authenticate, requireRole, requireClassSubjectAccess } = require('../middleware/auth');
const { scoreFor, statusOptions, PRESET_SCORES } = require('../utils/scoring');
const { buildClassExportWorkbook } = require('../utils/excel');
const { gatherClassExportData } = require('../utils/exportData');

const router = express.Router();

router.use(authenticate, requireRole('teacher'));

router.get('/class-subjects', (req, res) => {
  const rows = db
    .prepare(
      `SELECT cs.id, cs.homeroom_teacher, c.name AS class_name, s.name AS subject_name
       FROM class_subjects cs
       JOIN classes c ON c.id = cs.class_id
       JOIN subjects s ON s.id = cs.subject_id
       WHERE cs.teacher_id = ?
       ORDER BY cs.id`
    )
    .all(req.user.id);
  res.json(rows);
});

router.get('/class-subjects/:id', requireClassSubjectAccess, (req, res) => {
  const row = db
    .prepare(
      `SELECT cs.id, cs.homeroom_teacher, c.name AS class_name, s.name AS subject_name
       FROM class_subjects cs
       JOIN classes c ON c.id = cs.class_id
       JOIN subjects s ON s.id = cs.subject_id
       WHERE cs.id = ?`
    )
    .get(req.classSubject.id);
  res.json(row);
});

router.get('/meta', (req, res) => {
  res.json({
    presetScores: PRESET_SCORES,
    singleStatusOptions: statusOptions('single'),
    doubleStatusOptions: statusOptions('double'),
  });
});

router.get('/class-subjects/:id/roster', requireClassSubjectAccess, (req, res) => {
  const students = db
    .prepare('SELECT * FROM students WHERE class_id = ? AND active = 1 ORDER BY seat_no')
    .all(req.classSubject.class_id);
  res.json(students);
});

// ---- 出席 ----
router.get('/class-subjects/:id/attendance', requireClassSubjectAccess, (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: '請提供日期' });
  const session = db
    .prepare('SELECT * FROM lesson_sessions WHERE class_subject_id = ? AND date = ?')
    .get(req.classSubject.id, date);
  if (!session) return res.json({ exists: false, periodMode: 'single', records: [] });
  const records = db.prepare('SELECT student_id, status, score FROM attendance_records WHERE session_id = ?').all(session.id);
  res.json({ exists: true, periodMode: session.period_mode, records });
});

router.post('/class-subjects/:id/attendance', requireClassSubjectAccess, (req, res) => {
  const { date, periodMode, records } = req.body || {};
  if (!date || !['single', 'double'].includes(periodMode) || !Array.isArray(records)) {
    return res.status(400).json({ error: '參數不完整' });
  }

  let scored;
  try {
    scored = records.map((r) => ({ studentId: r.studentId, status: r.status, score: scoreFor(periodMode, r.status) }));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const tx = db.transaction(() => {
    let session = db.prepare('SELECT * FROM lesson_sessions WHERE class_subject_id = ? AND date = ?').get(req.classSubject.id, date);
    if (session) {
      db.prepare('UPDATE lesson_sessions SET period_mode = ?, created_by = ?, updated_at = datetime(\'now\') WHERE id = ?').run(
        periodMode,
        req.user.id,
        session.id
      );
      db.prepare('DELETE FROM attendance_records WHERE session_id = ?').run(session.id);
    } else {
      const info = db
        .prepare('INSERT INTO lesson_sessions (class_subject_id, date, period_mode, created_by) VALUES (?,?,?,?)')
        .run(req.classSubject.id, date, periodMode, req.user.id);
      session = { id: info.lastInsertRowid };
    }
    const insert = db.prepare('INSERT INTO attendance_records (session_id, student_id, status, score) VALUES (?,?,?,?)');
    for (const r of scored) insert.run(session.id, r.studentId, r.status, r.score);
  });
  tx();

  res.json({ ok: true, records: scored });
});

// ---- 表現分 / 堂課分 (共用邏輯) ----
function makeScoreEndpoints(table) {
  router.get(`/class-subjects/:id/${table}`, requireClassSubjectAccess, (req, res) => {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: '請提供日期' });
    const rows = db
      .prepare(`SELECT student_id, score FROM ${table} WHERE class_subject_id = ? AND date = ?`)
      .all(req.classSubject.id, date);
    res.json({ records: rows });
  });

  router.post(`/class-subjects/:id/${table}`, requireClassSubjectAccess, (req, res) => {
    const { date, records } = req.body || {};
    if (!date || !Array.isArray(records)) return res.status(400).json({ error: '參數不完整' });
    for (const r of records) {
      if (typeof r.score !== 'number' || r.score < 0 || r.score > 100) {
        return res.status(400).json({ error: '分數必須係 0-100 之間嘅數字' });
      }
    }
    const upsert = db.prepare(
      `INSERT INTO ${table} (class_subject_id, student_id, date, score, updated_by, updated_at)
       VALUES (?,?,?,?,?,datetime('now'))
       ON CONFLICT(class_subject_id, student_id, date)
       DO UPDATE SET score = excluded.score, updated_by = excluded.updated_by, updated_at = datetime('now')`
    );
    const tx = db.transaction(() => {
      for (const r of records) upsert.run(req.classSubject.id, r.studentId, date, r.score, req.user.id);
    });
    tx();
    res.json({ ok: true });
  });
}
makeScoreEndpoints('performance_scores');
makeScoreEndpoints('lesson_scores');

// ---- 大測 ----
router.get('/class-subjects/:id/tests', requireClassSubjectAccess, (req, res) => {
  const tests = db.prepare('SELECT * FROM tests WHERE class_subject_id = ? ORDER BY date DESC, id DESC').all(req.classSubject.id);
  res.json(tests);
});

router.post('/class-subjects/:id/tests', requireClassSubjectAccess, (req, res) => {
  const { name, date } = req.body || {};
  if (!name || !date) return res.status(400).json({ error: '請輸入測驗名稱同日期' });
  const info = db
    .prepare('INSERT INTO tests (class_subject_id, name, date, created_by) VALUES (?,?,?,?)')
    .run(req.classSubject.id, name, date, req.user.id);
  res.status(201).json({ id: info.lastInsertRowid });
});

router.get('/tests/:testId/scores', (req, res) => {
  const test = db.prepare('SELECT * FROM tests WHERE id = ?').get(req.params.testId);
  if (!test) return res.status(404).json({ error: '搵唔到測驗' });
  const cs = db.prepare('SELECT * FROM class_subjects WHERE id = ?').get(test.class_subject_id);
  if (cs.teacher_id !== req.user.id) return res.status(403).json({ error: '權限不足' });
  const rows = db.prepare('SELECT student_id, score FROM test_scores WHERE test_id = ?').all(test.id);
  res.json({ records: rows });
});

router.post('/tests/:testId/scores', (req, res) => {
  const test = db.prepare('SELECT * FROM tests WHERE id = ?').get(req.params.testId);
  if (!test) return res.status(404).json({ error: '搵唔到測驗' });
  const cs = db.prepare('SELECT * FROM class_subjects WHERE id = ?').get(test.class_subject_id);
  if (cs.teacher_id !== req.user.id) return res.status(403).json({ error: '權限不足' });
  const { records } = req.body || {};
  if (!Array.isArray(records)) return res.status(400).json({ error: '參數不完整' });
  for (const r of records) {
    if (typeof r.score !== 'number' || r.score < 0 || r.score > 100) {
      return res.status(400).json({ error: '分數必須係 0-100 之間嘅數字' });
    }
  }
  const upsert = db.prepare(
    `INSERT INTO test_scores (test_id, student_id, score) VALUES (?,?,?)
     ON CONFLICT(test_id, student_id) DO UPDATE SET score = excluded.score`
  );
  const tx = db.transaction(() => {
    for (const r of records) upsert.run(test.id, r.studentId, r.score);
  });
  tx();
  res.json({ ok: true });
});

// ---- 匯出 ----
router.get('/class-subjects/:id/export', requireClassSubjectAccess, async (req, res) => {
  const exportData = gatherClassExportData(req.classSubject);
  const workbook = await buildClassExportWorkbook(exportData);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="export.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
});

module.exports = router;
