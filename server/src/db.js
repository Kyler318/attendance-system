const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'attendance.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// node:sqlite (DatabaseSync) 冇 better-sqlite3 嘅 db.transaction() 語法糖,自己包一個
db.transaction = function transaction(fn) {
  return (...args) => {
    db.exec('BEGIN');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
};

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','teacher')),
  display_name TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS remember_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  selector TEXT UNIQUE NOT NULL,
  validator_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subjects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS class_subjects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  homeroom_teacher TEXT DEFAULT '',
  UNIQUE(class_id, subject_id)
);

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  seat_no INTEGER NOT NULL,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(class_id, seat_no)
);

CREATE TABLE IF NOT EXISTS lesson_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_subject_id INTEGER NOT NULL REFERENCES class_subjects(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  period_mode TEXT NOT NULL CHECK(period_mode IN ('single','double')),
  created_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(class_subject_id, date)
);

CREATE TABLE IF NOT EXISTS attendance_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES lesson_sessions(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  score REAL NOT NULL,
  UNIQUE(session_id, student_id)
);

CREATE TABLE IF NOT EXISTS performance_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_subject_id INTEGER NOT NULL REFERENCES class_subjects(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  score REAL NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(class_subject_id, student_id, date)
);

CREATE TABLE IF NOT EXISTS lesson_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_subject_id INTEGER NOT NULL REFERENCES class_subjects(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  score REAL NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(class_subject_id, student_id, date)
);

CREATE TABLE IF NOT EXISTS tests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_subject_id INTEGER NOT NULL REFERENCES class_subjects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  date TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS test_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  score REAL NOT NULL,
  UNIQUE(test_id, student_id)
);
`);

// Seed default admin account if no users exist yet
const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
if (userCount === 0) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare(
    'INSERT INTO users (username, password_hash, role, display_name, must_change_password) VALUES (?,?,?,?,1)'
  ).run('admin', hash, 'admin', '系統管理員');
  console.log('已建立預設管理員帳號 admin / admin123 (請盡快登入並更改密碼)');
}

module.exports = db;
