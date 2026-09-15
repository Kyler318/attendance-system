const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
require('./db'); // 初始化 DB + migration + seed admin

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
app.listen(PORT, () => {
  console.log(`Attendance server listening on http://localhost:${PORT}`);
});
