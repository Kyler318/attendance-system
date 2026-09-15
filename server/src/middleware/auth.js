const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');

const SESSION_COOKIE = 'sid';
const REMEMBER_COOKIE = 'remember';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 小時
const REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 日

function isProd() {
  return process.env.NODE_ENV === 'production';
}

function baseCookieOpts() {
  return { httpOnly: true, sameSite: 'lax', secure: isProd() };
}

function createSession(res, userId) {
  const id = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?,?,?)').run(id, userId, expiresAt);
  res.cookie(SESSION_COOKIE, id, { ...baseCookieOpts(), expires: new Date(expiresAt) });
  return id;
}

function destroySession(req, res) {
  const sid = req.cookies[SESSION_COOKIE];
  if (sid) db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
  res.clearCookie(SESSION_COOKIE, baseCookieOpts());
}

function createRememberToken(res, userId) {
  const selector = crypto.randomBytes(16).toString('hex');
  const validator = crypto.randomBytes(32).toString('hex');
  const validatorHash = bcrypt.hashSync(validator, 10);
  const expiresAt = new Date(Date.now() + REMEMBER_TTL_MS).toISOString();
  db.prepare(
    'INSERT INTO remember_tokens (user_id, selector, validator_hash, expires_at) VALUES (?,?,?,?)'
  ).run(userId, selector, validatorHash, expiresAt);
  res.cookie(REMEMBER_COOKIE, `${selector}:${validator}`, { ...baseCookieOpts(), expires: new Date(expiresAt) });
}

function clearRememberToken(req, res) {
  const raw = req.cookies[REMEMBER_COOKIE];
  if (raw) {
    const [selector] = raw.split(':');
    db.prepare('DELETE FROM remember_tokens WHERE selector = ?').run(selector);
  }
  res.clearCookie(REMEMBER_COOKIE, baseCookieOpts());
}

function getUserById(id) {
  return db.prepare('SELECT id, username, role, display_name, must_change_password FROM users WHERE id = ?').get(id);
}

// 嘗試用 session cookie 認證;失敗再嘗試 remember-me cookie(成功就自動建立新 session + 輪換 remember token)
function authenticate(req, res, next) {
  const sid = req.cookies[SESSION_COOKIE];
  if (sid) {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
    if (session && new Date(session.expires_at) > new Date()) {
      const user = getUserById(session.user_id);
      if (user) {
        req.user = user;
        return next();
      }
    } else if (session) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
    }
  }

  const remember = req.cookies[REMEMBER_COOKIE];
  if (remember) {
    const [selector, validator] = remember.split(':');
    const token = selector && db.prepare('SELECT * FROM remember_tokens WHERE selector = ?').get(selector);
    if (token && new Date(token.expires_at) > new Date() && bcrypt.compareSync(validator || '', token.validator_hash)) {
      const user = getUserById(token.user_id);
      if (user) {
        // 輪換 token,避免重放
        db.prepare('DELETE FROM remember_tokens WHERE id = ?').run(token.id);
        createRememberToken(res, user.id);
        createSession(res, user.id);
        req.user = user;
        return next();
      }
    }
    clearRememberToken(req, res);
  }

  return res.status(401).json({ error: '未登入' });
}

function requireRole(role) {
  return (req, res, next) => {
    if (req.user.role !== role) return res.status(403).json({ error: '權限不足' });
    next();
  };
}

// 確認老師擁有呢個 class_subject 嘅存取權(admin 一律放行)
function requireClassSubjectAccess(req, res, next) {
  const id = Number(req.params.id);
  const cs = db.prepare('SELECT * FROM class_subjects WHERE id = ?').get(id);
  if (!cs) return res.status(404).json({ error: '找不到班級/科目' });
  if (req.user.role !== 'admin' && cs.teacher_id !== req.user.id) {
    return res.status(403).json({ error: '你冇呢個班級/科目嘅權限' });
  }
  req.classSubject = cs;
  next();
}

module.exports = {
  authenticate,
  requireRole,
  requireClassSubjectAccess,
  createSession,
  destroySession,
  createRememberToken,
  clearRememberToken,
};
