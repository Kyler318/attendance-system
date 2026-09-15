const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const {
  authenticate,
  createSession,
  destroySession,
  createRememberToken,
  clearRememberToken,
} = require('../middleware/auth');

const router = express.Router();

router.post('/login', (req, res) => {
  const { username, password, rememberMe } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '請輸入帳號同密碼' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: '帳號或密碼錯誤' });
  }

  createSession(res, user.id);
  if (rememberMe) createRememberToken(res, user.id);

  res.json({
    id: user.id,
    username: user.username,
    role: user.role,
    displayName: user.display_name,
    mustChangePassword: !!user.must_change_password,
  });
});

router.post('/logout', (req, res) => {
  destroySession(req, res);
  clearRememberToken(req, res);
  res.json({ ok: true });
});

router.get('/me', authenticate, (req, res) => {
  res.json({
    id: req.user.id,
    username: req.user.username,
    role: req.user.role,
    displayName: req.user.display_name,
    mustChangePassword: !!req.user.must_change_password,
  });
});

router.post('/change-password', authenticate, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: '新密碼最少 6 個字元' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(oldPassword || '', user.password_hash)) {
    return res.status(401).json({ error: '原密碼不正確' });
  }
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hash, user.id);
  res.json({ ok: true });
});

module.exports = router;
