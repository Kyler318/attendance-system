const { Pool } = require('pg');
const { AsyncLocalStorage } = require('async_hooks');
const bcrypt = require('bcryptjs');

if (!process.env.DATABASE_URL) {
  throw new Error(
    '未設定 DATABASE_URL 環境變數。請喺 Render 建立一個 Postgres,並將佢嘅 Internal/External Connection String ' +
      '設做 DATABASE_URL(本機開發可以用 server/.env 檔案,或者直接用 Render 果個 Postgres 嘅 External URL)。'
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render 嘅 Postgres 用自簽證書,需要呢個先連得到;本機/其他有正式證書嘅環境唔受影響
  ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
});

// 用嚟喺 db.transaction() 入面,將同一個 transaction 底下所有 db.prepare().get/all/run()
// 都路由去同一條 client 連線(而唔係各自攞池入面唔同嘅連線),保證交易嘅原子性。
// 用 AsyncLocalStorage 嚟做,唔會受同時處理緊嘅其他 request 影響(唔會撞用錯連線)。
const als = new AsyncLocalStorage();

function executor() {
  return als.getStore() || pool;
}

// node:sqlite / better-sqlite3 用 '?' 做 placeholder,pg 要用 $1 $2 ...,呢度自動轉
function toPgSql(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function prepare(sql) {
  const pgSql = toPgSql(sql);
  return {
    async get(...params) {
      const { rows } = await executor().query(pgSql, params);
      return rows[0];
    },
    async all(...params) {
      const { rows } = await executor().query(pgSql, params);
      return rows;
    },
    async run(...params) {
      const { rows, rowCount } = await executor().query(pgSql, params);
      // 如果 SQL 入面有寫 `RETURNING id`,咁 rows[0].id 就係新增/更新嗰行嘅 id
      return { lastInsertRowid: rows[0] ? rows[0].id : undefined, changes: rowCount };
    },
  };
}

// 一個 transaction 入面成個 fn 必須係 async function,入面每個 db 調用都要 await
function transaction(fn) {
  return async (...args) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await als.run(client, () => fn(...args));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback error
      }
      throw err;
    } finally {
      client.release();
    }
  };
}

async function exec(sql) {
  await executor().query(sql);
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','teacher')),
  display_name TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (now()::text)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS remember_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  selector TEXT UNIQUE NOT NULL,
  validator_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS classes (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  class_type TEXT NOT NULL DEFAULT 'general',
  created_at TEXT NOT NULL DEFAULT (now()::text)
);

CREATE TABLE IF NOT EXISTS subjects (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS class_subjects (
  id SERIAL PRIMARY KEY,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  homeroom_teacher TEXT DEFAULT '',
  UNIQUE(class_id, subject_id)
);

CREATE TABLE IF NOT EXISTS students (
  id SERIAL PRIMARY KEY,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  seat_no INTEGER NOT NULL,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(class_id, seat_no)
);

CREATE TABLE IF NOT EXISTS lesson_sessions (
  id SERIAL PRIMARY KEY,
  class_subject_id INTEGER NOT NULL REFERENCES class_subjects(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  period_mode TEXT NOT NULL CHECK(period_mode IN ('single','double')),
  created_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (now()::text),
  UNIQUE(class_subject_id, date)
);

CREATE TABLE IF NOT EXISTS attendance_records (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES lesson_sessions(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  score REAL NOT NULL,
  UNIQUE(session_id, student_id)
);

CREATE TABLE IF NOT EXISTS performance_scores (
  id SERIAL PRIMARY KEY,
  class_subject_id INTEGER NOT NULL REFERENCES class_subjects(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  score REAL NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (now()::text),
  UNIQUE(class_subject_id, student_id, date)
);

CREATE TABLE IF NOT EXISTS lesson_scores (
  id SERIAL PRIMARY KEY,
  class_subject_id INTEGER NOT NULL REFERENCES class_subjects(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  score REAL NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (now()::text),
  UNIQUE(class_subject_id, student_id, date)
);

CREATE TABLE IF NOT EXISTS tests (
  id SERIAL PRIMARY KEY,
  class_subject_id INTEGER NOT NULL REFERENCES class_subjects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  date TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (now()::text)
);

CREATE TABLE IF NOT EXISTS test_scores (
  id SERIAL PRIMARY KEY,
  test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  score REAL NOT NULL,
  UNIQUE(test_id, student_id)
);
`;

let initPromise = null;

// 建立schema(如果未有)、seed 預設管理員帳號。index.js 會喺 app.listen() 之前 await 呢個
// function,保證資料庫準備好先開始接受請求。多次調用只會真正初始化一次。
function init() {
  if (!initPromise) {
    initPromise = (async () => {
      // 逐句執行 CREATE TABLE,唔好一個 query() 塞成嚿 multi-statement SQL —
      // pg 用 extended query protocol(有 bind 過程)嗰陣唔支援一次過幾句 statement
      const statements = SCHEMA_SQL.split(';').map((s) => s.trim()).filter(Boolean);
      for (const stmt of statements) await pool.query(stmt);

      // Migration:舊資料庫已經有 classes 表但冇 class_type 呢欄,補返(新資料庫嘅
      // CREATE TABLE 已經有呢欄,呢句係 no-op)
      await pool.query("ALTER TABLE classes ADD COLUMN IF NOT EXISTS class_type TEXT NOT NULL DEFAULT 'general'");

      const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM users');
      if (rows[0].c === 0) {
        const hash = bcrypt.hashSync('admin123', 10);
        await pool.query(
          'INSERT INTO users (username, password_hash, role, display_name, must_change_password) VALUES ($1,$2,$3,$4,1)',
          ['admin', hash, 'admin', '系統管理員']
        );
        // eslint-disable-next-line no-console
        console.log('已建立預設管理員帳號 admin / admin123 (請盡快登入並更改密碼)');
      }
    })();
  }
  return initPromise;
}

module.exports = { prepare, transaction, exec, init, pool };
