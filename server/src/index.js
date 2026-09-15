const path = require('path');
const fs = require('fs');
// 本機開發時,如果有 server/.env 就讀入嚟(例如 DATABASE_URL 指去 Render 嗰個 Postgres);
// 正式環境(Render)嘅環境變數由 Render 自己注入,唔靠呢個檔案
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const express = require('express');
const cookieParser = require('cookie-parser');
const db = require('./db');

const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const teacherRoutes = require('./routes/teacher');

const app = express();
app.use(express.json());
app.use(cookieParser());

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/teacher', teacherRoutes);

// 正式環境:直接 serve 前端 build 出嚟嘅靜態檔案
const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'), (err) => {
    if (err) res.status(404).send('前端未 build,開發時請用 client 嘅 vite dev server');
  });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: '伺服器內部錯誤' });
});

const PORT = process.env.PORT || 3000;

async function main() {
  await db.init(); // 建立 schema(如果未有) + seed 預設管理員,要等呢個做完先開始收 request
  app.listen(PORT, () => {
    console.log(`Attendance server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('伺服器啟動失敗:', err);
  process.exit(1);
});
