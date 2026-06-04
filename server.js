const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const JWT_SECRET = 'greenpower_secret_key_2024!@#';

// Create uploads directory
if (!fs.existsSync('./public/uploads')) {
  fs.mkdirSync('./public/uploads', { recursive: true });
}

// Database (sql.js = pure JS, no native bindings)
const initSqlJs = require('sql.js');
const DB_FILE = 'greenpower.db';
let db;

const toSqlParams = (params) => {
  if (params.length === 0) return undefined;
  if (params.length === 1 && (Array.isArray(params[0]) || (params[0] && typeof params[0] === 'object'))) {
    return params[0];
  }
  return params;
};

const getLastInsertRowid = (rawDb) => {
  const result = rawDb.exec('SELECT last_insert_rowid() AS id');
  return result[0]?.values?.[0]?.[0] || 0;
};

const saveDatabase = (rawDb) => {
  fs.writeFileSync(DB_FILE, Buffer.from(rawDb.export()));
};

const wrapDatabase = (rawDb) => ({
  exec: (sql) => {
    const result = rawDb.exec(sql);
    saveDatabase(rawDb);
    return result;
  },
  export: () => rawDb.export(),
  prepare: (sql) => ({
    run: (...params) => {
      const stmt = rawDb.prepare(sql);
      let result;
      try {
        const sqlParams = toSqlParams(params);
        if (sqlParams === undefined) stmt.run();
        else stmt.run(sqlParams);
        result = {
          changes: rawDb.getRowsModified(),
          lastInsertRowid: getLastInsertRowid(rawDb)
        };
      } finally {
        stmt.free();
      }
      saveDatabase(rawDb);
      return result;
    },
    get: (...params) => {
      const stmt = rawDb.prepare(sql);
      try {
        const sqlParams = toSqlParams(params);
        if (sqlParams !== undefined) stmt.bind(sqlParams);
        return stmt.step() ? stmt.getAsObject() : undefined;
      } finally {
        stmt.free();
      }
    },
    all: (...params) => {
      const stmt = rawDb.prepare(sql);
      const rows = [];
      try {
        const sqlParams = toSqlParams(params);
        if (sqlParams !== undefined) stmt.bind(sqlParams);
        while (stmt.step()) rows.push(stmt.getAsObject());
        return rows;
      } finally {
        stmt.free();
      }
    }
  })
});

initSqlJs({ locateFile: (file) => `node_modules/sql.js/dist/${file}` }).then(async (SQLLib) => {

  // ✅ FIX: Agar .db file exist kare toh load karo, nahi toh naya banao
  let SQL;
  if (fs.existsSync(DB_FILE) && fs.statSync(DB_FILE).size > 0) {
    SQL = fs.readFileSync(DB_FILE);
    db = wrapDatabase(new SQLLib.Database(SQL));
  } else {
    db = wrapDatabase(new SQLLib.Database()); // naya empty database
  }

  db.exec('PRAGMA journal_mode = WAL;');

  // Initialize database tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      name TEXT DEFAULT 'User',
      avatar TEXT DEFAULT '',
      invite_code TEXT UNIQUE,
      invited_by TEXT DEFAULT NULL,
      balance REAL DEFAULT 0,
      withdraw_balance REAL DEFAULT 0,
      total_recharge REAL DEFAULT 0,
      total_withdraw REAL DEFAULT 0,
      vip_level INTEGER DEFAULT 0,
      is_admin INTEGER DEFAULT 0,
      is_banned INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE IF NOT EXISTS investment_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price REAL NOT NULL,
      total_income REAL NOT NULL,
      cycle_days INTEGER NOT NULL,
      daily_income REAL NOT NULL,
      category TEXT DEFAULT 'vip',
      image_url TEXT DEFAULT '',
      description TEXT DEFAULT '',
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE IF NOT EXISTS user_purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      plan_id INTEGER NOT NULL,
      purchase_date TEXT DEFAULT CURRENT_TIMESTAMP,
      expire_date TEXT,
      daily_income REAL NOT NULL,
      total_income REAL NOT NULL,
      earned_income REAL DEFAULT 0,
      days_remaining INTEGER,
      status TEXT DEFAULT 'active',
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (plan_id) REFERENCES investment_plans(id)
    );
    
    CREATE TABLE IF NOT EXISTS deposits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      payment_method TEXT DEFAULT 'UPI',
      proof_image TEXT DEFAULT '',
      transaction_id TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      note TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      approved_at TEXT DEFAULT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    
    CREATE TABLE IF NOT EXISTS withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      bank_name TEXT DEFAULT '',
      account_number TEXT DEFAULT '',
      account_name TEXT DEFAULT '',
      ifsc TEXT DEFAULT '',
      upi_id TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      note TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      approved_at TEXT DEFAULT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    
    CREATE TABLE IF NOT EXISTS bank_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT DEFAULT 'bank',
      bank_name TEXT DEFAULT '',
      account_name TEXT DEFAULT '',
      account_number TEXT DEFAULT '',
      ifsc TEXT DEFAULT '',
      upi_id TEXT DEFAULT '',
      is_default INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      description TEXT DEFAULT '',
      balance_after REAL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    
    CREATE TABLE IF NOT EXISTS commissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      from_user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      type TEXT DEFAULT 'referral',
      description TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (from_user_id) REFERENCES users(id)
    );
    
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT DEFAULT ''
    );
  `);

  // Insert default settings
  const defaultSettings = [
    ['site_name', 'Green Power'],
    ['site_logo', ''],
    ['min_deposit', '100'],
    ['max_deposit', '1000000'],
    ['min_withdraw', '100'],
    ['max_withdraw', '500000'],
    ['commission_level1', '10'],
    ['commission_level2', '5'],
    ['commission_level3', '3'],
    ['upi_id', 'greenpower@upi'],
    ['upi_name', 'Green Power'],
    ['bank_name', 'HDFC Bank'],
    ['bank_account', '1234567890'],
    ['bank_ifsc', 'HDFC0000001'],
    ['bank_holder', 'Green Power India'],
    ['withdrawal_note', 'Processed within 24 hours'],
    ['deposit_note', 'Send payment and upload screenshot'],
    ['welcome_bonus', '0'],
  ];

  for (const [key, value] of defaultSettings) {
    try {
      db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(key, value);
    } catch (e) {}
  }

  // Insert default plans
  const plansCount = db.prepare('SELECT COUNT(*) as count FROM investment_plans').get();
  if (plansCount.count === 0) {
    const planData = [
      { name: 'Green Power Starter', price: 495, total_income: 8000, cycle_days: 47, daily_income: 170, category: 'vip' },
      { name: 'Green Power Basic', price: 1095, total_income: 19000, cycle_days: 47, daily_income: 404, category: 'vip' },
      { name: 'Green Power Plus', price: 2095, total_income: 38000, cycle_days: 47, daily_income: 809, category: 'vip' },
      { name: 'Green Power Pro', price: 4595, total_income: 85000, cycle_days: 47, daily_income: 1809, category: 'vip' },
      { name: 'Solar Fixed 30', price: 1000, total_income: 15000, cycle_days: 30, daily_income: 500, category: 'fixed' },
      { name: 'Wind Fixed 60', price: 5000, total_income: 80000, cycle_days: 60, daily_income: 1333, category: 'fixed' },
      { name: 'Hydro Event', price: 299, total_income: 5000, cycle_days: 20, daily_income: 250, category: 'event' },
    ];
    for (const plan of planData) {
      db.prepare('INSERT INTO investment_plans (name, price, total_income, cycle_days, daily_income, category) VALUES (?, ?, ?, ?, ?, ?)')
        .run(plan.name, plan.price, plan.total_income, plan.cycle_days, plan.daily_income, plan.category);
    }
  }

  // Create default admin
  const adminExists = db.prepare('SELECT id FROM users WHERE is_admin = 1').get();
  if (!adminExists) {
    const hashedPwd = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO users (phone, password, name, invite_code, is_admin) VALUES (?, ?, ?, ?, 1)')
      .run('admin', hashedPwd, 'Admin', 'ADMIN001');
  }

  // Multer setup
  const storage = multer.diskStorage({
    destination: (req, file, cb) => { cb(null, './public/uploads/'); },
    filename: (req, file, cb) => { cb(null, Date.now() + '_' + Math.random().toString(36).substr(2, 9) + path.extname(file.originalname)); }
  });
  const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

  // Middleware
  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));
  app.use(express.static('public'));
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
  app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
  app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

  // JWT Auth
  const auth = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    try {
      req.user = jwt.verify(token, JWT_SECRET);
      next();
    } catch { res.status(401).json({ error: 'Invalid token' }); }
  };

  const adminAuth = (req, res, next) => {
    auth(req, res, () => {
      if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
      next();
    });
  };

  const generateInviteCode = () => Math.floor(1000000000 + Math.random() * 9000000000).toString();

  // ===== AUTH =====
  app.post('/api/auth/register', (req, res) => {
    const { phone, password, invite_code } = req.body;
    if (!phone || !password) return res.status(400).json({ error: 'Phone and password required' });
    
    const existing = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
    if (existing) return res.status(400).json({ error: 'Already registered' });
    
    let invitedBy = null;
    if (invite_code) {
      const inviter = db.prepare('SELECT id FROM users WHERE invite_code = ?').get(invite_code);
      if (inviter) invitedBy = invite_code;
    }
    
    const hashedPwd = bcrypt.hashSync(password, 10);
    const newCode = generateInviteCode();
    const welcomeBonus = parseFloat(db.prepare("SELECT value FROM settings WHERE key = 'welcome_bonus'").get()?.value || '0');
    
    const result = db.prepare('INSERT INTO users (phone, password, invite_code, invited_by, balance) VALUES (?, ?, ?, ?, ?)')
      .run(phone, hashedPwd, newCode, invitedBy, welcomeBonus);
    
    if (welcomeBonus > 0) {
      db.prepare('INSERT INTO transactions (user_id, type, amount, description, balance_after) VALUES (?, ?, ?, ?, ?)')
        .run(result.lastInsertRowid, 'bonus', welcomeBonus, 'Welcome bonus', welcomeBonus);
    }
    
    const token = jwt.sign({ id: result.lastInsertRowid, phone, is_admin: 0 }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, user: { id: result.lastInsertRowid, phone, invite_code: newCode } });
  });

  app.post('/api/auth/login', (req, res) => {
    const { phone, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    if (!user || !bcrypt.compareSync(password, user.password)) return res.status(400).json({ error: 'Invalid credentials' });
    if (user.is_banned) return res.status(403).json({ error: 'Account banned' });
    
    const token = jwt.sign({ id: user.id, phone, is_admin: user.is_admin }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, user: { id: user.id, phone, name: user.name, invite_code: user.invite_code, is_admin: user.is_admin } });
  });

  // ===== USER ROUTES =====
  app.get('/api/user/profile', auth, (req, res) => {
    const user = db.prepare('SELECT id, phone, name, avatar, invite_code, balance, withdraw_balance, total_recharge, total_withdraw, vip_level, created_at FROM users WHERE id = ?').get(req.user.id);
    const team = db.prepare("SELECT COUNT(*) as count FROM users WHERE invited_by = ?").get(user.invite_code);
    const earned = db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM commissions WHERE user_id = ?").get(user.id);
    res.json({ ...user, team_count: team.count, total_earned: earned.total });
  });

  app.put('/api/user/profile', auth, (req, res) => {
    const { name } = req.body;
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id);
    res.json({ success: true });
  });

  app.get('/api/user/purchases', auth, (req, res) => {
    const purchases = db.prepare('SELECT up.*, ip.name FROM user_purchases up JOIN investment_plans ip ON up.plan_id = ip.id WHERE up.user_id = ? ORDER BY up.purchase_date DESC').all(req.user.id);
    res.json(purchases);
  });

  app.get('/api/user/transactions', auth, (req, res) => {
    const { type, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    let query = 'SELECT * FROM transactions WHERE user_id = ?';
    const params = [req.user.id];
    if (type) { query += ' AND type = ?'; params.push(type); }
    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), offset);
    const transactions = db.prepare(query).all(...params);
    res.json(transactions);
  });

  app.get('/api/user/commissions', auth, (req, res) => {
    const commissions = db.prepare('SELECT c.*, u.phone FROM commissions c LEFT JOIN users u ON c.from_user_id = u.id WHERE c.user_id = ? ORDER BY c.created_at DESC LIMIT 50').all(req.user.id);
    const total = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM commissions WHERE user_id = ?').get(req.user.id);
    res.json({ commissions, total: total.total });
  });

  app.get('/api/user/team', auth, (req, res) => {
    const user = db.prepare('SELECT invite_code FROM users WHERE id = ?').get(req.user.id);
    const team = db.prepare('SELECT id, phone, name, created_at, balance, vip_level FROM users WHERE invited_by = ? ORDER BY created_at DESC LIMIT 100').all(user.invite_code);
    const totalComm = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM commissions WHERE user_id = ?').get(req.user.id);
    res.json({ team, team_count: team.length, total_commission: totalComm.total });
  });

  app.get('/api/user/bank-cards', auth, (req, res) => {
    const cards = db.prepare('SELECT * FROM bank_cards WHERE user_id = ? ORDER BY is_default DESC, created_at DESC').all(req.user.id);
    res.json(cards);
  });

  app.post('/api/user/bank-cards', auth, (req, res) => {
    const { type, bank_name, account_name, account_number, ifsc, upi_id } = req.body;
    const result = db.prepare('INSERT INTO bank_cards (user_id, type, bank_name, account_name, account_number, ifsc, upi_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(req.user.id, type || 'bank', bank_name || '', account_name || '', account_number || '', ifsc || '', upi_id || '');
    res.json({ success: true, id: result.lastInsertRowid });
  });

  app.delete('/api/user/bank-cards/:id', auth, (req, res) => {
    db.prepare('DELETE FROM bank_cards WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    res.json({ success: true });
  });

  // ===== PLANS =====
  app.get('/api/plans', auth, (req, res) => {
    const { category } = req.query;
    let query = 'SELECT * FROM investment_plans WHERE is_active = 1';
    if (category) query += ' AND category = ?';
    query += ' ORDER BY price ASC';
    const plans = db.prepare(query).all(...(category ? [category] : []));
    res.json(plans);
  });

  app.post('/api/plans/purchase', auth, (req, res) => {
    const { plan_id } = req.body;
    const plan = db.prepare('SELECT * FROM investment_plans WHERE id = ? AND is_active = 1').get(plan_id);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (user.balance < plan.price) return res.status(400).json({ error: 'Insufficient balance' });
    
    const expireDate = new Date(Date.now() + plan.cycle_days * 86400000).toISOString();
    db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(plan.price, req.user.id);
    
    const purchase = db.prepare('INSERT INTO user_purchases (user_id, plan_id, expire_date, daily_income, total_income, days_remaining) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.user.id, plan.id, expireDate, plan.daily_income, plan.total_income, plan.cycle_days);
    
    db.prepare('INSERT INTO transactions (user_id, type, amount, description, balance_after) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, 'purchase', -plan.price, `Purchased ${plan.name}`, user.balance - plan.price);
    
    if (user.invited_by) {
      const referrer = db.prepare('SELECT * FROM users WHERE invite_code = ?').get(user.invited_by);
      if (referrer) {
        const comm = plan.price * 0.1;
        db.prepare('UPDATE users SET withdraw_balance = withdraw_balance + ? WHERE id = ?').run(comm, referrer.id);
        db.prepare('INSERT INTO commissions (user_id, from_user_id, amount, type, description) VALUES (?, ?, ?, ?, ?)')
          .run(referrer.id, req.user.id, comm, 'referral', `Commission from purchase`);
      }
    }
    
    res.json({ success: true, message: 'Plan purchased', purchase_id: purchase.lastInsertRowid });
  });

  // ===== DEPOSITS =====
  app.post('/api/deposits', auth, upload.single('proof'), (req, res) => {
    const { amount, payment_method, transaction_id } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
    
    const minDep = parseFloat(db.prepare("SELECT value FROM settings WHERE key = 'min_deposit'").get()?.value || '100');
    if (amount < minDep) return res.status(400).json({ error: `Min: ₹${minDep}` });
    
    const proof = req.file ? `/uploads/${req.file.filename}` : '';
    db.prepare('INSERT INTO deposits (user_id, amount, payment_method, proof_image, transaction_id) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, parseFloat(amount), payment_method || 'UPI', proof, transaction_id || '');
    
    res.json({ success: true, message: 'Deposit submitted. Pending approval.' });
  });

  app.get('/api/deposits', auth, (req, res) => {
    const deposits = db.prepare('SELECT * FROM deposits WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
    res.json(deposits);
  });

  // ===== WITHDRAWALS =====
  app.post('/api/withdrawals', auth, (req, res) => {
    const { amount, bank_card_id } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
    
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const minWith = parseFloat(db.prepare("SELECT value FROM settings WHERE key = 'min_withdraw'").get()?.value || '100');
    
    if (amount < minWith) return res.status(400).json({ error: `Min: ₹${minWith}` });
    if (user.withdraw_balance < amount) return res.status(400).json({ error: 'Insufficient balance' });
    
    let cardInfo = {};
    if (bank_card_id) {
      const card = db.prepare('SELECT * FROM bank_cards WHERE id = ? AND user_id = ?').get(bank_card_id, req.user.id);
      if (card) cardInfo = { bank_name: card.bank_name, account_number: card.account_number, account_name: card.account_name, ifsc: card.ifsc, upi_id: card.upi_id };
    }
    
    db.prepare('UPDATE users SET withdraw_balance = withdraw_balance - ? WHERE id = ?').run(parseFloat(amount), req.user.id);
    db.prepare('INSERT INTO withdrawals (user_id, amount, bank_name, account_number, account_name, ifsc, upi_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(req.user.id, parseFloat(amount), cardInfo.bank_name || '', cardInfo.account_number || '', cardInfo.account_name || '', cardInfo.ifsc || '', cardInfo.upi_id || '');
    
    db.prepare('INSERT INTO transactions (user_id, type, amount, description) VALUES (?, ?, ?, ?)')
      .run(req.user.id, 'withdraw', -amount, 'Withdrawal request');
    
    res.json({ success: true, message: 'Withdrawal requested. Processing in 24 hours.' });
  });

  app.get('/api/withdrawals', auth, (req, res) => {
    const withdrawals = db.prepare('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
    res.json(withdrawals);
  });

  app.post('/api/upload', auth, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    res.json({ url: `/uploads/${req.file.filename}` });
  });

  // ===== ADMIN =====
  app.get('/api/admin/dashboard', adminAuth, (req, res) => {
    const stats = {
      total_users: db.prepare('SELECT COUNT(*) as count FROM users WHERE is_admin = 0').get().count,
      total_deposits: db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM deposits WHERE status = 'approved'").get().total,
      total_withdrawals: db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM withdrawals WHERE status = 'approved'").get().total,
      total_plans_sold: db.prepare('SELECT COUNT(*) as count FROM user_purchases').get().count,
      pending_deposits: db.prepare("SELECT COUNT(*) as count FROM deposits WHERE status = 'pending'").get().count,
      pending_withdrawals: db.prepare("SELECT COUNT(*) as count FROM withdrawals WHERE status = 'pending'").get().count,
    };
    const recent_users = db.prepare('SELECT id, phone, name, balance, created_at FROM users WHERE is_admin = 0 ORDER BY created_at DESC LIMIT 10').all();
    const recent_deposits = db.prepare('SELECT d.*, u.phone FROM deposits d JOIN users u ON d.user_id = u.id WHERE d.status = "pending" ORDER BY d.created_at DESC LIMIT 10').all();
    res.json({ stats, recent_users, recent_deposits });
  });

  app.get('/api/admin/users', adminAuth, (req, res) => {
    const { search, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    let query = 'SELECT id, phone, name, balance, withdraw_balance, total_recharge, invite_code, vip_level, is_banned, created_at FROM users WHERE is_admin = 0';
    const params = [];
    if (search) { query += ' AND (phone LIKE ? OR name LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), offset);
    const users = db.prepare(query).all(...params);
    const total = db.prepare('SELECT COUNT(*) as count FROM users WHERE is_admin = 0').get().count;
    res.json({ users, total });
  });

  app.put('/api/admin/users/:id', adminAuth, (req, res) => {
    const { name, balance, withdraw_balance, vip_level, is_banned } = req.body;
    db.prepare('UPDATE users SET name = COALESCE(?, name), balance = COALESCE(?, balance), withdraw_balance = COALESCE(?, withdraw_balance), vip_level = COALESCE(?, vip_level), is_banned = COALESCE(?, is_banned) WHERE id = ?')
      .run(name, balance !== undefined ? balance : null, withdraw_balance !== undefined ? withdraw_balance : null, vip_level, is_banned, req.params.id);
    res.json({ success: true });
  });

  app.delete('/api/admin/users/:id', adminAuth, (req, res) => {
    db.prepare('DELETE FROM users WHERE id = ? AND is_admin = 0').run(req.params.id);
    res.json({ success: true });
  });

  // Plans CRUD
  app.get('/api/admin/plans', adminAuth, (req, res) => {
    const plans = db.prepare('SELECT * FROM investment_plans ORDER BY category, price ASC').all();
    res.json(plans);
  });

  app.post('/api/admin/plans', adminAuth, upload.single('image'), (req, res) => {
    const { name, price, total_income, cycle_days, daily_income, category, description } = req.body;
    const img = req.file ? `/uploads/${req.file.filename}` : '';
    const result = db.prepare('INSERT INTO investment_plans (name, price, total_income, cycle_days, daily_income, category, image_url, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(name, parseFloat(price), parseFloat(total_income), parseInt(cycle_days), parseFloat(daily_income), category || 'vip', img, description || '');
    res.json({ success: true, id: result.lastInsertRowid });
  });

  app.put('/api/admin/plans/:id', adminAuth, upload.single('image'), (req, res) => {
    const { name, price, total_income, cycle_days, daily_income, category, description, is_active } = req.body;
    const img = req.file ? `/uploads/${req.file.filename}` : null;
    if (img) {
      db.prepare('UPDATE investment_plans SET name = ?, price = ?, total_income = ?, cycle_days = ?, daily_income = ?, category = ?, description = ?, is_active = ?, image_url = ? WHERE id = ?')
        .run(name, parseFloat(price), parseFloat(total_income), parseInt(cycle_days), parseFloat(daily_income), category, description || '', is_active || 1, img, req.params.id);
    } else {
      db.prepare('UPDATE investment_plans SET name = ?, price = ?, total_income = ?, cycle_days = ?, daily_income = ?, category = ?, description = ?, is_active = ? WHERE id = ?')
        .run(name, parseFloat(price), parseFloat(total_income), parseInt(cycle_days), parseFloat(daily_income), category, description || '', is_active || 1, req.params.id);
    }
    res.json({ success: true });
  });

  app.delete('/api/admin/plans/:id', adminAuth, (req, res) => {
    db.prepare('DELETE FROM investment_plans WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  });

  // Deposits
  app.get('/api/admin/deposits', adminAuth, (req, res) => {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    let query = 'SELECT d.*, u.phone, u.name FROM deposits d JOIN users u ON d.user_id = u.id';
    const params = [];
    if (status) { query += ' WHERE d.status = ?'; params.push(status); }
    query += ' ORDER BY d.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), offset);
    const deposits = db.prepare(query).all(...params);
    const total = db.prepare('SELECT COUNT(*) as count FROM deposits').get().count;
    res.json({ deposits, total });
  });

  app.put('/api/admin/deposits/:id/approve', adminAuth, (req, res) => {
    const deposit = db.prepare('SELECT * FROM deposits WHERE id = ?').get(req.params.id);
    if (!deposit || deposit.status !== 'pending') return res.status(400).json({ error: 'Invalid' });
    db.prepare("UPDATE deposits SET status = 'approved', approved_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    db.prepare('UPDATE users SET balance = balance + ?, total_recharge = total_recharge + ? WHERE id = ?').run(deposit.amount, deposit.amount, deposit.user_id);
    db.prepare('INSERT INTO transactions (user_id, type, amount, description) VALUES (?, ?, ?, ?)').run(deposit.user_id, 'deposit', deposit.amount, 'Deposit approved');
    res.json({ success: true });
  });

  app.put('/api/admin/deposits/:id/reject', adminAuth, (req, res) => {
    const { note } = req.body;
    db.prepare("UPDATE deposits SET status = 'rejected', note = ? WHERE id = ?").run(note || 'Rejected', req.params.id);
    res.json({ success: true });
  });

  // Withdrawals
  app.get('/api/admin/withdrawals', adminAuth, (req, res) => {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    let query = 'SELECT w.*, u.phone, u.name FROM withdrawals w JOIN users u ON w.user_id = u.id';
    const params = [];
    if (status) { query += ' WHERE w.status = ?'; params.push(status); }
    query += ' ORDER BY w.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), offset);
    const withdrawals = db.prepare(query).all(...params);
    const total = db.prepare('SELECT COUNT(*) as count FROM withdrawals').get().count;
    res.json({ withdrawals, total });
  });

  app.put('/api/admin/withdrawals/:id/approve', adminAuth, (req, res) => {
    const withdrawal = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(req.params.id);
    if (!withdrawal || withdrawal.status !== 'pending') return res.status(400).json({ error: 'Invalid' });
    db.prepare("UPDATE withdrawals SET status = 'approved', approved_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    db.prepare('UPDATE users SET total_withdraw = total_withdraw + ? WHERE id = ?').run(withdrawal.amount, withdrawal.user_id);
    db.prepare('INSERT INTO transactions (user_id, type, amount, description) VALUES (?, ?, ?, ?)').run(withdrawal.user_id, 'withdraw_approved', withdrawal.amount, 'Withdrawal approved');
    res.json({ success: true });
  });

  app.put('/api/admin/withdrawals/:id/reject', adminAuth, (req, res) => {
    const { note } = req.body;
    const withdrawal = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(req.params.id);
    if (!withdrawal || withdrawal.status !== 'pending') return res.status(400).json({ error: 'Invalid' });
    db.prepare("UPDATE withdrawals SET status = 'rejected', note = ? WHERE id = ?").run(note || 'Rejected', req.params.id);
    db.prepare('UPDATE users SET withdraw_balance = withdraw_balance + ? WHERE id = ?').run(withdrawal.amount, withdrawal.user_id);
    res.json({ success: true });
  });

  // Settings
  app.get('/api/admin/settings', adminAuth, (req, res) => {
    const settings = db.prepare('SELECT * FROM settings').all();
    const obj = {};
    settings.forEach(s => obj[s.key] = s.value);
    res.json(obj);
  });

  app.put('/api/admin/settings', adminAuth, upload.single('logo'), (req, res) => {
    const data = req.body;
    if (req.file) data.site_logo = `/uploads/${req.file.filename}`;
    for (const [key, value] of Object.entries(data)) {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
    }
    res.json({ success: true });
  });

  // Public settings
  app.get('/api/settings', (req, res) => {
    const settings = db.prepare("SELECT key, value FROM settings").all();
    const obj = {};
    settings.forEach(s => obj[s.key] = s.value);
    res.json(obj);
  });

  // Generate QR Code for UPI
  app.post('/api/generate-qr', adminAuth, async (req, res) => {
    const { upi_id, amount } = req.body;
    if (!upi_id) return res.status(400).json({ error: 'UPI ID required' });
    try {
      const upiString = `upi://pay?pa=${upi_id}&pn=GreenPower${amount ? '&am=' + amount : ''}`;
      const qrCode = await QRCode.toDataURL(upiString);
      res.json({ success: true, qr: qrCode, upiString });
    } catch (e) {
      res.status(400).json({ error: 'QR generation failed' });
    }
  });

  // Get payment QR (for checkout)
  app.get('/api/payment-qr/:amount', async (req, res) => {
    try {
      const upiId = db.prepare("SELECT value FROM settings WHERE key = 'upi_id'").get()?.value || 'greenpower@upi';
      const amount = req.params.amount;
      const upiString = `upi://pay?pa=${upiId}&pn=GreenPower&am=${amount}`;
      const qrCode = await QRCode.toDataURL(upiString);
      res.json({ success: true, qr: qrCode, upiId, amount });
    } catch (e) {
      res.status(400).json({ error: 'QR generation failed' });
    }
  });

  // Daily earnings
  const calculateEarnings = () => {
    const today = new Date().toISOString().split('T')[0];
    const active = db.prepare("SELECT up.*, u.id as uid FROM user_purchases up JOIN users u ON up.user_id = u.id WHERE up.status = 'active' AND up.earned_income < up.total_income").all();
    for (const p of active) {
      const paid = db.prepare("SELECT id FROM transactions WHERE user_id = ? AND type = 'earning' AND DATE(created_at) = ?").get(p.uid, today);
      if (!paid) {
        const newEarned = Math.min(p.earned_income + p.daily_income, p.total_income);
        db.prepare('UPDATE users SET withdraw_balance = withdraw_balance + ? WHERE id = ?').run(p.daily_income, p.uid);
        db.prepare('UPDATE user_purchases SET earned_income = ?, days_remaining = days_remaining - 1, status = ? WHERE id = ?')
          .run(newEarned, newEarned >= p.total_income ? 'completed' : 'active', p.id);
        db.prepare('INSERT INTO transactions (user_id, type, amount, description) VALUES (?, ?, ?, ?)').run(p.uid, 'earning', p.daily_income, 'Daily earning');
      }
    }
  };

  setInterval(calculateEarnings, 3600000);
  calculateEarnings();

  // Save DB on exit
  process.on('SIGINT', () => {
    try {
      const data = db.export();
      fs.writeFileSync(DB_FILE, Buffer.from(data));
      console.log('\n💾 Database saved!');
    } catch (e) {}
    process.exit(0);
  });

  // ✅ Single app.listen at the end
  const PORT = process.env.PORT || 10000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Green Power Server Running on port ${PORT}`);

  console.log(`📱 User App Running`);
  console.log(`⚙️ Admin Panel Ready`);
  console.log(`🔐 Admin Login: phone=admin | password=admin123`);
});

}).catch(err => {
  console.error('❌ Database init failed:', err);
  process.exit(1);
});
