const db = require('../db');

// 收集某個 class_subject 嘅所有資料,組合成 buildClassExportWorkbook 需要嘅格式
async function gatherClassExportData(classSubject) {
  const cls = await db.prepare('SELECT * FROM classes WHERE id = ?').get(classSubject.class_id);
  const subject = await db.prepare('SELECT * FROM subjects WHERE id = ?').get(classSubject.subject_id);
  const studentRows = await db
    .prepare('SELECT * FROM students WHERE class_id = ? AND active = 1 ORDER BY seat_no')
    .all(classSubject.class_id);
  const students = studentRows.map((s) => ({ id: s.id, seatNo: s.seat_no, name: s.name }));

  const sessionRows = await db
    .prepare(
      `SELECT ls.date AS date, ls.session_type AS session_type, ar.student_id AS student_id, ar.status AS status, ar.score AS score
       FROM attendance_records ar
       JOIN lesson_sessions ls ON ls.id = ar.session_id
       WHERE ls.class_subject_id = ?`
    )
    .all(classSubject.id);
  // 範本每日只有一格出席分,要將日間 / 夜間合併做一格(逐個學生計):
  // 日間點到名(唔係缺席)就用日間;日間缺席或者冇日間記錄,有夜間就用夜間;都冇就用日間(即係缺席 0 分)
  const byStudentDate = new Map();
  for (const r of sessionRows) {
    const key = `${r.date}|${r.student_id}`;
    if (!byStudentDate.has(key)) byStudentDate.set(key, { date: r.date, student_id: r.student_id });
    byStudentDate.get(key)[r.session_type] = r;
  }
  const attendanceRows = Array.from(byStudentDate.values()).map(({ date, student_id, day, night }) => {
    const pick = day && day.status !== 'absent' ? day : night || day;
    return { date, student_id, score: pick.score };
  });

  const performanceRows = await db
    .prepare('SELECT date, student_id, score FROM performance_scores WHERE class_subject_id = ?')
    .all(classSubject.id);

  const lessonScoreRows = await db
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

  const testsRaw = await db.prepare('SELECT * FROM tests WHERE class_subject_id = ? ORDER BY date, id').all(classSubject.id);
  const tests = [];
  for (const t of testsRaw) {
    const scoreRows = await db.prepare('SELECT student_id, score FROM test_scores WHERE test_id = ?').all(t.id);
    const scores = new Map(scoreRows.map((r) => [r.student_id, r.score]));
    tests.push({ id: t.id, name: t.name, date: t.date, scores });
  }

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
