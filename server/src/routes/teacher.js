const express = require('express');
const db = require('../db');
const { authenticate, requireRole, requireClassSubjectAccess } = require('../middleware/auth');
const { scoreFor, statusOptions, PRESET_SCORES } = require('../utils/scoring');
const { buildClassExportWorkbook } = require('../utils/excel');
const { gatherClassExportData } = require('../utils/exportData');

const router = express.Router();

router.use(authenticate, requireRole('teacher'));

// 統一錯誤處理:所有 handler 都係 async,錯誤會經 next(err) 落去 index.js 嘅 error middleware
function h(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

router.get(
  '/class-subjects',
  h(async (req, res) => {
    const rows = await db
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
  })
);

router.get(
  '/class-subjects/:id',
  requireClassSubjectAccess,
  h(async (req, res) => {
    const row = await db
      .prepare(
        `SELECT cs.id, cs.homeroom_teacher, c.name AS class_name, c.class_type AS class_type, s.name AS subject_name
       FROM class_subjects cs
       JOIN classes c ON c.id = cs.class_id
       JOIN subjects s ON s.id = cs.subject_id
       WHERE cs.id = ?`
      )
      .get(req.classSubject.id);
    res.json(row);
  })
);

// classType(普中 general / 職中 vocational)會影響單節出席「遲到」嘅分數,由前端帶落嚟
// (前端會先攞 class-subject 資訊知道個 class_type,先至再攞呢個 meta)
router.get('/meta', (req, res) => {
  const classType = req.query.classType;
  res.json({
    presetScores: PRESET_SCORES,
    singleStatusOptions: statusOptions('single', classType),
    doubleStatusOptions: statusOptions('double', classType),
  });
});

router.get(
  '/class-subjects/:id/roster',
  requireClassSubjectAccess,
  h(async (req, res) => {
    const students = await db
      .prepare('SELECT * FROM students WHERE class_id = ? AND active = 1 ORDER BY seat_no')
      .all(req.classSubject.class_id);
    res.json(students);
  })
);

// ---- 出席 ----
// 每日可以有「日間課程」同「夜間課程」兩個點名 session(session_type = 'day' / 'night')。
// 夜間係選填(唔係每班都有);日間已經點到名(狀態唔係缺席)嘅學生,夜間唔使再點,
// 夜間淨係點日間未點到嘅學生
const SESSION_TYPES = ['day', 'night'];

async function sessionsByType(classSubjectId, date) {
  const rows = await db.prepare('SELECT * FROM lesson_sessions WHERE class_subject_id = ? AND date = ?').all(classSubjectId, date);
  return { day: rows.find((r) => r.session_type === 'day'), night: rows.find((r) => r.session_type === 'night') };
}

async function presentStudentIds(session) {
  if (!session) return [];
  const rows = await db
    .prepare("SELECT student_id FROM attendance_records WHERE session_id = ? AND status <> 'absent'")
    .all(session.id);
  return rows.map((r) => r.student_id);
}

router.get(
  '/class-subjects/:id/attendance',
  requireClassSubjectAccess,
  h(async (req, res) => {
    const { date } = req.query;
    const sessionType = req.query.sessionType || 'day';
    if (!date) return res.status(400).json({ error: '請提供日期' });
    if (!SESSION_TYPES.includes(sessionType)) return res.status(400).json({ error: '無效嘅課程類型' });
    const sessions = await sessionsByType(req.classSubject.id, date);
    const flags = {
      dayExists: !!sessions.day,
      nightExists: !!sessions.night,
      dayPresentStudentIds: await presentStudentIds(sessions.day),
      nightPresentStudentIds: await presentStudentIds(sessions.night),
    };
    const session = sessions[sessionType];
    if (!session) return res.json({ exists: false, periodMode: 'single', records: [], ...flags });
    const records = await db.prepare('SELECT student_id, status, score FROM attendance_records WHERE session_id = ?').all(session.id);
    res.json({ exists: true, periodMode: session.period_mode, records, ...flags });
  })
);

router.post(
  '/class-subjects/:id/attendance',
  requireClassSubjectAccess,
  h(async (req, res) => {
    const { date, periodMode, records } = req.body || {};
    const sessionType = req.body?.sessionType || 'day';
    if (!date || !['single', 'double'].includes(periodMode) || !Array.isArray(records) || !SESSION_TYPES.includes(sessionType)) {
      return res.status(400).json({ error: '參數不完整' });
    }

    let scored;
    try {
      scored = records.map((r) => ({
        studentId: r.studentId,
        status: r.status,
        score: scoreFor(periodMode, r.status, req.classSubject.class_type),
      }));
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const tx = db.transaction(async () => {
      const sessions = await sessionsByType(req.classSubject.id, date);
      if (sessionType === 'night') {
        // 日間已點到名嘅學生唔使(亦唔會)記錄夜間出席
        const present = new Set(await presentStudentIds(sessions.day));
        scored = scored.filter((r) => !present.has(r.studentId));
        if (scored.length === 0) {
          const err = new Error('呢啲學生日間已經點到名,夜間課程唔使再點名');
          err.status = 400;
          throw err;
        }
      }
      let session = sessions[sessionType];
      if (session) {
        await db
          .prepare("UPDATE lesson_sessions SET period_mode = ?, created_by = ?, updated_at = now()::text WHERE id = ?")
          .run(periodMode, req.user.id, session.id);
        await db.prepare('DELETE FROM attendance_records WHERE session_id = ?').run(session.id);
      } else {
        const info = await db
          .prepare('INSERT INTO lesson_sessions (class_subject_id, date, period_mode, session_type, created_by) VALUES (?,?,?,?,?) RETURNING id')
          .run(req.classSubject.id, date, periodMode, sessionType, req.user.id);
        session = { id: info.lastInsertRowid };
      }
      const insert = db.prepare('INSERT INTO attendance_records (session_id, student_id, status, score) VALUES (?,?,?,?)');
      for (const r of scored) await insert.run(session.id, r.studentId, r.status, r.score);
    });
    try {
      await tx();
    } catch (e) {
      if (e.status === 400) return res.status(400).json({ error: e.message });
      throw e;
    }

    res.json({ ok: true, records: scored });
  })
);

// ---- 表現分 / 堂課分 (共用邏輯) ----
function makeScoreEndpoints(table) {
  router.get(
    `/class-subjects/:id/${table}`,
    requireClassSubjectAccess,
    h(async (req, res) => {
      const { date } = req.query;
      if (!date) return res.status(400).json({ error: '請提供日期' });
      const rows = await db
        .prepare(`SELECT student_id, score FROM ${table} WHERE class_subject_id = ? AND date = ?`)
        .all(req.classSubject.id, date);
      res.json({ records: rows });
    })
  );

  router.post(
    `/class-subjects/:id/${table}`,
    requireClassSubjectAccess,
    h(async (req, res) => {
      const { date, records } = req.body || {};
      if (!date || !Array.isArray(records)) return res.status(400).json({ error: '參數不完整' });
      for (const r of records) {
        if (typeof r.score !== 'number' || r.score < 0 || r.score > 100) {
          return res.status(400).json({ error: '分數必須係 0-100 之間嘅數字' });
        }
      }
      const upsert = db.prepare(
        `INSERT INTO ${table} (class_subject_id, student_id, date, score, updated_by, updated_at)
       VALUES (?,?,?,?,?,now()::text)
       ON CONFLICT(class_subject_id, student_id, date)
       DO UPDATE SET score = excluded.score, updated_by = excluded.updated_by, updated_at = now()::text`
      );
      const tx = db.transaction(async () => {
        for (const r of records) await upsert.run(req.classSubject.id, r.studentId, date, r.score, req.user.id);
      });
      await tx();
      res.json({ ok: true });
    })
  );
}
makeScoreEndpoints('performance_scores');
makeScoreEndpoints('lesson_scores');

// 刪除某一日嘅記錄(日間/夜間出席 + 表現分 + 堂課分 一齊刪,對應「今日課堂記錄」個合併畫面),不可還原
router.delete(
  '/class-subjects/:id/daily-record',
  requireClassSubjectAccess,
  h(async (req, res) => {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: '請提供日期' });
    const tx = db.transaction(async () => {
      // 日間 + 夜間 兩個 session 一齊刪,cascade 埋 attendance_records
      await db.prepare('DELETE FROM lesson_sessions WHERE class_subject_id = ? AND date = ?').run(req.classSubject.id, date);
      await db.prepare('DELETE FROM performance_scores WHERE class_subject_id = ? AND date = ?').run(req.classSubject.id, date);
      await db.prepare('DELETE FROM lesson_scores WHERE class_subject_id = ? AND date = ?').run(req.classSubject.id, date);
    });
    await tx();
    res.json({ ok: true });
  })
);

// ---- 抽籤轉盤 ----
// 轉盤入面係嗰日有出席嘅學生(日間或者夜間任何一個唔係缺席),抽中咗嘅會記錄落 draw_records,
// 唔會再喺嗰日個轉盤出現
async function drawState(classSubject, date) {
  const present = await db
    .prepare(
      `SELECT DISTINCT s.id, s.seat_no, s.name
       FROM students s
       JOIN attendance_records ar ON ar.student_id = s.id
       JOIN lesson_sessions ls ON ls.id = ar.session_id
       WHERE ls.class_subject_id = ? AND ls.date = ? AND ar.status <> 'absent'
         AND s.class_id = ? AND s.active = 1
       ORDER BY s.seat_no`
    )
    .all(classSubject.id, date, classSubject.class_id);
  const records = await db
    .prepare(
      `SELECT dr.id, dr.student_id, dr.drawn_at, dr.bonus, s.seat_no, s.name, ps.score AS performance_score
       FROM draw_records dr
       JOIN students s ON s.id = dr.student_id
       LEFT JOIN performance_scores ps
         ON ps.class_subject_id = dr.class_subject_id AND ps.student_id = dr.student_id AND ps.date = dr.date
       WHERE dr.class_subject_id = ? AND dr.date = ?
       ORDER BY dr.id`
    )
    .all(classSubject.id, date);
  const drawn = new Set(records.map((r) => r.student_id));
  return { present, remaining: present.filter((s) => !drawn.has(s.id)), records };
}

router.get(
  '/class-subjects/:id/draw',
  requireClassSubjectAccess,
  h(async (req, res) => {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: '請提供日期' });
    res.json(await drawState(req.classSubject, date));
  })
);

router.post(
  '/class-subjects/:id/draw',
  requireClassSubjectAccess,
  h(async (req, res) => {
    const { date, studentId } = req.body || {};
    if (!date || !studentId) return res.status(400).json({ error: '參數不完整' });
    const state = await drawState(req.classSubject, date);
    if (!state.remaining.some((s) => s.id === studentId)) {
      return res.status(400).json({ error: '呢個學生唔喺今日個轉盤入面(未出席或者已經抽過)' });
    }
    await db
      .prepare('INSERT INTO draw_records (class_subject_id, student_id, date, drawn_by) VALUES (?,?,?,?) ON CONFLICT DO NOTHING')
      .run(req.classSubject.id, studentId, date, req.user.id);
    res.json(await drawState(req.classSubject, date));
  })
);

// 抽中嘅學生答完問題加表現分:每個抽籤記錄最多加一次(+20,上限 100)。
// 嗰日未有表現分嘅學生由 0 開始加
const DRAW_BONUS = 20;
router.post(
  '/class-subjects/:id/draw/bonus',
  requireClassSubjectAccess,
  h(async (req, res) => {
    const { date, recordIds } = req.body || {};
    if (!date || !Array.isArray(recordIds) || recordIds.length === 0) return res.status(400).json({ error: '參數不完整' });
    const tx = db.transaction(async () => {
      for (const recordId of recordIds) {
        const rec = await db
          .prepare('SELECT * FROM draw_records WHERE id = ? AND class_subject_id = ? AND date = ? AND bonus = 0')
          .get(recordId, req.classSubject.id, date);
        if (!rec) continue; // 已經加過或者唔屬於呢日,跳過
        const cur = await db
          .prepare('SELECT score FROM performance_scores WHERE class_subject_id = ? AND student_id = ? AND date = ?')
          .get(req.classSubject.id, rec.student_id, date);
        const score = Math.min(100, (cur ? cur.score : 0) + DRAW_BONUS);
        await db
          .prepare(
            `INSERT INTO performance_scores (class_subject_id, student_id, date, score, updated_by, updated_at)
             VALUES (?,?,?,?,?,now()::text)
             ON CONFLICT(class_subject_id, student_id, date)
             DO UPDATE SET score = excluded.score, updated_by = excluded.updated_by, updated_at = now()::text`
          )
          .run(req.classSubject.id, rec.student_id, date, score, req.user.id);
        await db.prepare('UPDATE draw_records SET bonus = ? WHERE id = ?').run(DRAW_BONUS, rec.id);
      }
    });
    await tx();
    res.json(await drawState(req.classSubject, date));
  })
);

// 重置某日個轉盤:淨係刪走嗰日嘅抽籤記錄,全部出席學生放返入轉盤(唔會郁出席/評分記錄)
router.delete(
  '/class-subjects/:id/draw',
  requireClassSubjectAccess,
  h(async (req, res) => {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: '請提供日期' });
    await db.prepare('DELETE FROM draw_records WHERE class_subject_id = ? AND date = ?').run(req.classSubject.id, date);
    res.json(await drawState(req.classSubject, date));
  })
);

// ---- 大測 ----
router.get(
  '/class-subjects/:id/tests',
  requireClassSubjectAccess,
  h(async (req, res) => {
    const tests = await db.prepare('SELECT * FROM tests WHERE class_subject_id = ? ORDER BY date DESC, id DESC').all(req.classSubject.id);
    res.json(tests);
  })
);

router.post(
  '/class-subjects/:id/tests',
  requireClassSubjectAccess,
  h(async (req, res) => {
    const { name, date } = req.body || {};
    if (!name || !date) return res.status(400).json({ error: '請輸入測驗名稱同日期' });
    const info = await db
      .prepare('INSERT INTO tests (class_subject_id, name, date, created_by) VALUES (?,?,?,?) RETURNING id')
      .run(req.classSubject.id, name, date, req.user.id);
    res.status(201).json({ id: info.lastInsertRowid });
  })
);

router.get(
  '/tests/:testId/scores',
  h(async (req, res) => {
    const test = await db.prepare('SELECT * FROM tests WHERE id = ?').get(req.params.testId);
    if (!test) return res.status(404).json({ error: '搵唔到測驗' });
    const cs = await db.prepare('SELECT * FROM class_subjects WHERE id = ?').get(test.class_subject_id);
    if (cs.teacher_id !== req.user.id) return res.status(403).json({ error: '權限不足' });
    const rows = await db.prepare('SELECT student_id, score FROM test_scores WHERE test_id = ?').all(test.id);
    res.json({ records: rows });
  })
);

router.post(
  '/tests/:testId/scores',
  h(async (req, res) => {
    const test = await db.prepare('SELECT * FROM tests WHERE id = ?').get(req.params.testId);
    if (!test) return res.status(404).json({ error: '搵唔到測驗' });
    const cs = await db.prepare('SELECT * FROM class_subjects WHERE id = ?').get(test.class_subject_id);
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
    const tx = db.transaction(async () => {
      for (const r of records) await upsert.run(test.id, r.studentId, r.score);
    });
    await tx();
    res.json({ ok: true });
  })
);

// ---- 匯出 ----
router.get(
  '/class-subjects/:id/export',
  requireClassSubjectAccess,
  h(async (req, res) => {
    const exportData = await gatherClassExportData(req.classSubject);
    const workbook = await buildClassExportWorkbook(exportData);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="export.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  })
);

module.exports = router;
