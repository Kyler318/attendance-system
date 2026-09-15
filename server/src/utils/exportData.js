const db = require('../db');

// 收集某個 class_subject 嘅所有資料,組合成 buildClassExportWorkbook 需要嘅格式
function gatherClassExportData(classSubject) {
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(classSubject.class_id);
  const subject = db.prepare('SELECT * FROM subjects WHERE id = ?').get(classSubject.subject_id);
  const students = db
    .prepare('SELECT * FROM students WHERE class_id = ? AND active = 1 ORDER BY seat_no')
    .all(classSubject.class_id)
    .map((s) => ({ id: s.id, seatNo: s.seat_no, name: s.name }));

  const attendanceRows = db
    .prepare(
      `SELECT ls.date AS date, ar.student_id AS student_id, ar.score AS score
       FROM attendance_records ar
       JOIN lesson_sessions ls ON ls.id = ar.session_id
       WHERE ls.class_subject_id = ?`
    )
    .all(classSubject.id);

  const performanceRows = db
    .prepare('SELECT date, student_id, score FROM performance_scores WHERE class_subject_id = ?')
    .all(classSubject.id);

  const lessonScoreRows = db
    .prepare('SELECT date, student_id, score FROM lesson_scores WHERE class_subject_id = ?')
    .all(classSubject.id);

  const uniqueSortedDates = (rows) => Array.from(new Set(rows.map((r) => r.date))).sort();
  const attendanceDates = uniqueSortedDates(attendanceRows);
  const performanceDates = uniqueSortedDates(performanceRows);
  const lessonDates = uniqueSortedDates(lessonScoreRows);

  const dateSet = new Set([...attendanceDates, ...performanceDates, ...lessonDates]);
  const dates = Array.from(dateSet).sort();

  const toMap = (rows) => {
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.date)) map.set(r.date, new Map());
      map.get(r.date).set(r.student_id, r.score);
    }
    return map;
  };

  const testsRaw = db.prepare('SELECT * FROM tests WHERE class_subject_id = ? ORDER BY date, id').all(classSubject.id);
  const tests = testsRaw.map((t) => {
    const scoreRows = db.prepare('SELECT student_id, score FROM test_scores WHERE test_id = ?').all(t.id);
    const scores = new Map(scoreRows.map((r) => [r.student_id, r.score]));
    return { id: t.id, name: t.name, date: t.date, scores };
  });

  return {
    className: cls?.name || '',
    subjectName: subject?.name || '',
    homeroomTeacher: classSubject.homeroom_teacher || '',
    students,
    dates,
    attendanceDates,
    performanceDates,
    lessonDates,
    attendanceMap: toMap(attendanceRows),
    performanceMap: toMap(performanceRows),
    lessonScoreMap: toMap(lessonScoreRows),
    tests,
  };
}

module.exports = { gatherClassExportData };
