const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const QRCode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'greenpower_secret_key_2024!@#';

// ✅ SUPABASE CLIENT
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Create uploads directory
if (!fs.existsSync('./public/uploads')) {
  fs.mkdirSync('./public/uploads', { recursive: true });
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
app.post('/api/auth/register', async (req, res) => {
  try {
    const { phone, password, invite_code } = req.body;
    if (!phone || !password) return res.status(400).json({ error: 'Phone and password required' });

    const { data: existing } = await supabase.from('users').select('id').eq('phone', phone).single();
    if (existing) return res.status(400).json({ error: 'Already registered' });

    let invitedBy = null;
    if (invite_code) {
      const { data: inviter } = await supabase.from('users').select('id').eq('invite_code', invite_code).single();
      if (inviter) invitedBy = invite_code;
    }

    const hashedPwd = bcrypt.hashSync(password, 10);
    const newCode = generateInviteCode();

    const { data: settings } = await supabase.from('settings').select('value').eq('key', 'welcome_bonus').single();
    const welcomeBonus = parseFloat(settings?.value || '0');

    const { data: newUser, error } = await supabase.from('users')
      .insert({ phone, password: hashedPwd, invite_code: newCode, invited_by: invitedBy, balance: welcomeBonus })
      .select().single();

    if (error) return res.status(400).json({ error: error.message });

    if (welcomeBonus > 0) {
      await supabase.from('transactions').insert({ user_id: newUser.id, type: 'bonus', amount: welcomeBonus, description: 'Welcome bonus', balance_after: welcomeBonus });
    }

    const token = jwt.sign({ id: newUser.id, phone, is_admin: 0 }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, user: { id: newUser.id, phone, invite_code: newCode } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    const { data: user } = await supabase.from('users').select('*').eq('phone', phone).single();
    if (!user || !bcrypt.compareSync(password, user.password)) return res.status(400).json({ error: 'Invalid credentials' });
    if (user.is_banned) return res.status(403).json({ error: 'Account banned' });

    const token = jwt.sign({ id: user.id, phone, is_admin: user.is_admin }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, user: { id: user.id, phone, name: user.name, invite_code: user.invite_code, is_admin: user.is_admin } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== USER ROUTES =====
app.get('/api/user/profile', auth, async (req, res) => {
  try {
    const { data: user } = await supabase.from('users')
      .select('id, phone, name, avatar, invite_code, balance, withdraw_balance, total_recharge, total_withdraw, vip_level, created_at')
      .eq('id', req.user.id).single();
    const { count: team_count } = await supabase.from('users').select('id', { count: 'exact', head: true }).eq('invited_by', user.invite_code);
    const { data: earned } = await supabase.from('commissions').select('amount').eq('user_id', req.user.id);
    const total_earned = earned?.reduce((s, r) => s + r.amount, 0) || 0;
    res.json({ ...user, team_count: team_count || 0, total_earned });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/user/profile', auth, upload.single('avatar'), async (req, res) => {
  try {
    const { name } = req.body;
    const updates = {};
    if (name) updates.name = name;
    if (req.file) updates.avatar = `/uploads/${req.file.filename}`;
    await supabase.from('users').update(updates).eq('id', req.user.id);
    const { data: user } = await supabase.from('users')
      .select('id, phone, name, avatar, invite_code, balance, withdraw_balance, total_recharge, total_withdraw, vip_level')
      .eq('id', req.user.id).single();
    res.json({ success: true, user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/user/purchases', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('user_purchases')
      .select('*, investment_plans(name)').eq('user_id', req.user.id).order('purchase_date', { ascending: false });
    const purchases = data?.map(p => ({ ...p, name: p.investment_plans?.name })) || [];
    res.json(purchases);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/user/transactions', auth, async (req, res) => {
  try {
    const { type, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    let query = supabase.from('transactions').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).range(offset, offset + parseInt(limit) - 1);
    if (type) query = query.eq('type', type);
    const { data } = await query;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/user/commissions', auth, async (req, res) => {
  try {
    const { data: commissions } = await supabase.from('commissions')
      .select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(50);
    const total = commissions?.reduce((s, c) => s + c.amount, 0) || 0;
    res.json({ commissions: commissions || [], total });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/user/team', auth, async (req, res) => {
  try {
    const { data: user } = await supabase.from('users').select('invite_code').eq('id', req.user.id).single();
    const { data: team } = await supabase.from('users')
      .select('id, phone, name, created_at, balance, vip_level').eq('invited_by', user.invite_code).order('created_at', { ascending: false }).limit(100);
    const { data: commData } = await supabase.from('commissions').select('amount').eq('user_id', req.user.id);
    const total_commission = commData?.reduce((s, c) => s + c.amount, 0) || 0;
    res.json({ team: team || [], team_count: team?.length || 0, total_commission });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/user/bank-cards', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('bank_cards').select('*').eq('user_id', req.user.id).order('is_default', { ascending: false });
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/user/bank-cards', auth, async (req, res) => {
  try {
    const { type, bank_name, account_name, account_number, ifsc, upi_id } = req.body;
    const { data, error } = await supabase.from('bank_cards')
      .insert({ user_id: req.user.id, type: type || 'bank', bank_name: bank_name || '', account_name: account_name || '', account_number: account_number || '', ifsc: ifsc || '', upi_id: upi_id || '' })
      .select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, id: data.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/user/bank-cards/:id', auth, async (req, res) => {
  try {
    await supabase.from('bank_cards').delete().eq('id', req.params.id).eq('user_id', req.user.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== PLANS =====
app.get('/api/plans', auth, async (req, res) => {
  try {
    const { category } = req.query;
    let query = supabase.from('investment_plans').select('*').eq('is_active', 1).order('price');
    if (category) query = query.eq('category', category);
    const { data } = await query;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/plans/purchase', auth, async (req, res) => {
  try {
    const { plan_id } = req.body;
    const { data: plan } = await supabase.from('investment_plans').select('*').eq('id', plan_id).eq('is_active', 1).single();
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const { data: user } = await supabase.from('users').select('*').eq('id', req.user.id).single();
    if (user.balance < plan.price) return res.status(400).json({ error: 'Insufficient balance' });

    const expireDate = new Date(Date.now() + plan.cycle_days * 86400000).toISOString();
    await supabase.from('users').update({ balance: user.balance - plan.price }).eq('id', req.user.id);

    const { data: purchase } = await supabase.from('user_purchases')
      .insert({ user_id: req.user.id, plan_id: plan.id, expire_date: expireDate, daily_income: plan.daily_income, total_income: plan.total_income, days_remaining: plan.cycle_days })
      .select().single();

    await supabase.from('transactions').insert({ user_id: req.user.id, type: 'purchase', amount: -plan.price, description: `Purchased ${plan.name}`, balance_after: user.balance - plan.price });

    if (user.invited_by) {
      const { data: referrer } = await supabase.from('users').select('*').eq('invite_code', user.invited_by).single();
      if (referrer) {
        const comm = plan.price * 0.1;
        await supabase.from('users').update({ withdraw_balance: referrer.withdraw_balance + comm }).eq('id', referrer.id);
        await supabase.from('commissions').insert({ user_id: referrer.id, from_user_id: req.user.id, amount: comm, type: 'referral', description: 'Commission from purchase' });
      }
    }

    res.json({ success: true, message: 'Plan purchased', purchase_id: purchase.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== DEPOSITS =====
app.post('/api/deposits', auth, upload.single('proof'), async (req, res) => {
  try {
    const { amount, payment_method, transaction_id } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

    const { data: minSetting } = await supabase.from('settings').select('value').eq('key', 'min_deposit').single();
    const minDep = parseFloat(minSetting?.value || '100');
    if (parseFloat(amount) < minDep) return res.status(400).json({ error: `Min: Rs.${minDep}` });

    const proof = req.file ? `/uploads/${req.file.filename}` : '';
    await supabase.from('deposits').insert({ user_id: req.user.id, amount: parseFloat(amount), payment_method: payment_method || 'UPI', proof_image: proof, transaction_id: transaction_id || '' });

    res.json({ success: true, message: 'Deposit submitted. Pending approval.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/deposits', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('deposits').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== WITHDRAWALS =====
app.post('/api/withdrawals', auth, async (req, res) => {
  try {
    const { amount, bank_card_id, upi_id, account_number, ifsc, account_name } = req.body;
    if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Invalid amount' });

    const { data: user } = await supabase.from('users').select('*').eq('id', req.user.id).single();
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { data: minSetting } = await supabase.from('settings').select('value').eq('key', 'min_withdraw').single();
    const minWith = parseFloat(minSetting?.value || '100');
    const amt = parseFloat(amount);

    if (amt < minWith) return res.status(400).json({ error: `Min: Rs.${minWith}` });
    if (user.withdraw_balance < amt) return res.status(400).json({ error: 'Insufficient balance' });

    let cardInfo = { bank_name: '', account_number: account_number || '', account_name: account_name || '', ifsc: ifsc || '', upi_id: upi_id || '' };

    if (bank_card_id) {
      const { data: card } = await supabase.from('bank_cards').select('*').eq('id', bank_card_id).eq('user_id', req.user.id).single();
      if (card) cardInfo = { bank_name: card.bank_name, account_number: card.account_number, account_name: card.account_name, ifsc: card.ifsc, upi_id: card.upi_id };
    }

    await supabase.from('users').update({ withdraw_balance: user.withdraw_balance - amt }).eq('id', req.user.id);
    await supabase.from('withdrawals').insert({ user_id: req.user.id, amount: amt, ...cardInfo, status: 'pending' });
    await supabase.from('transactions').insert({ user_id: req.user.id, type: 'withdraw', amount: -amt, description: 'Withdrawal request' });

    res.json({ success: true, message: 'Withdrawal requested. Processing in 24 hours.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ✅ WITHDRAWAL HISTORY - User apni withdrawal history dekh sakta hai
app.get('/api/withdrawals', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('withdrawals').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/upload', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

// ===== ADMIN =====
app.get('/api/admin/dashboard', adminAuth, async (req, res) => {
  try {
    const [users, deps, withs, plans, pendDep, pendWith, recentUsers, recentDeps] = await Promise.all([
      supabase.from('users').select('id', { count: 'exact', head: true }).eq('is_admin', 0),
      supabase.from('deposits').select('amount').eq('status', 'approved'),
      supabase.from('withdrawals').select('amount').eq('status', 'approved'),
      supabase.from('user_purchases').select('id', { count: 'exact', head: true }),
      supabase.from('deposits').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('withdrawals').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('users').select('id, phone, name, balance, created_at').eq('is_admin', 0).order('created_at', { ascending: false }).limit(10),
      supabase.from('deposits').select('*, users(phone)').eq('status', 'pending').order('created_at', { ascending: false }).limit(10),
    ]);
    res.json({
      stats: {
        total_users: users.count || 0,
        total_deposits: deps.data?.reduce((s, d) => s + d.amount, 0) || 0,
        total_withdrawals: withs.data?.reduce((s, w) => s + w.amount, 0) || 0,
        total_plans_sold: plans.count || 0,
        pending_deposits: pendDep.count || 0,
        pending_withdrawals: pendWith.count || 0,
      },
      recent_users: recentUsers.data || [],
      recent_deposits: recentDeps.data?.map(d => ({ ...d, phone: d.users?.phone })) || [],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/users', adminAuth, async (req, res) => {
  try {
    const { search, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    let query = supabase.from('users').select('id, phone, name, balance, withdraw_balance, total_recharge, invite_code, vip_level, is_banned, created_at', { count: 'exact' })
      .eq('is_admin', 0).order('created_at', { ascending: false }).range(offset, offset + parseInt(limit) - 1);
    if (search) query = query.or(`phone.ilike.%${search}%,name.ilike.%${search}%`);
    const { data, count } = await query;
    res.json({ users: data || [], total: count || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/users/:id', adminAuth, async (req, res) => {
  try {
    const { name, balance, withdraw_balance, vip_level, is_banned } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (balance !== undefined) updates.balance = balance;
    if (withdraw_balance !== undefined) updates.withdraw_balance = withdraw_balance;
    if (vip_level !== undefined) updates.vip_level = vip_level;
    if (is_banned !== undefined) updates.is_banned = is_banned;
    await supabase.from('users').update(updates).eq('id', req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/users/:id', adminAuth, async (req, res) => {
  try {
    await supabase.from('users').delete().eq('id', req.params.id).eq('is_admin', 0);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/plans', adminAuth, async (req, res) => {
  try {
    const { data } = await supabase.from('investment_plans').select('*').order('category').order('price');
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/plans', adminAuth, upload.single('image'), async (req, res) => {
  try {
    const { name, price, total_income, cycle_days, daily_income, category, description } = req.body;
    const img = req.file ? `/uploads/${req.file.filename}` : '';
    const { data, error } = await supabase.from('investment_plans')
      .insert({ name, price: parseFloat(price), total_income: parseFloat(total_income), cycle_days: parseInt(cycle_days), daily_income: parseFloat(daily_income), category: category || 'vip', image_url: img, description: description || '' })
      .select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, id: data.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/plans/:id', adminAuth, upload.single('image'), async (req, res) => {
  try {
    const { name, price, total_income, cycle_days, daily_income, category, description, is_active } = req.body;
    const updates = { name, price: parseFloat(price), total_income: parseFloat(total_income), cycle_days: parseInt(cycle_days), daily_income: parseFloat(daily_income), category, description: description || '', is_active: is_active !== undefined ? is_active : 1 };
    if (req.file) updates.image_url = `/uploads/${req.file.filename}`;
    await supabase.from('investment_plans').update(updates).eq('id', req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/plans/:id', adminAuth, async (req, res) => {
  try {
    await supabase.from('investment_plans').delete().eq('id', req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/deposits', adminAuth, async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    let query = supabase.from('deposits').select('*, users(phone, name)', { count: 'exact' }).order('created_at', { ascending: false }).range(offset, offset + parseInt(limit) - 1);
    if (status) query = query.eq('status', status);
    const { data, count } = await query;
    res.json({ deposits: data?.map(d => ({ ...d, phone: d.users?.phone, name: d.users?.name })) || [], total: count || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/deposits/:id/approve', adminAuth, async (req, res) => {
  try {
    const { data: deposit } = await supabase.from('deposits').select('*').eq('id', req.params.id).single();
    if (!deposit || deposit.status !== 'pending') return res.status(400).json({ error: 'Invalid' });
    await supabase.from('deposits').update({ status: 'approved', approved_at: new Date().toISOString() }).eq('id', req.params.id);
    const { data: user } = await supabase.from('users').select('balance, total_recharge').eq('id', deposit.user_id).single();
    await supabase.from('users').update({ balance: user.balance + deposit.amount, total_recharge: user.total_recharge + deposit.amount }).eq('id', deposit.user_id);
    await supabase.from('transactions').insert({ user_id: deposit.user_id, type: 'deposit', amount: deposit.amount, description: 'Deposit approved' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/deposits/:id/reject', adminAuth, async (req, res) => {
  try {
    const { note } = req.body;
    await supabase.from('deposits').update({ status: 'rejected', note: note || 'Rejected' }).eq('id', req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/withdrawals', adminAuth, async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    let query = supabase.from('withdrawals').select('*, users(phone, name)', { count: 'exact' }).order('created_at', { ascending: false }).range(offset, offset + parseInt(limit) - 1);
    if (status) query = query.eq('status', status);
    const { data, count } = await query;
    res.json({ withdrawals: data?.map(w => ({ ...w, phone: w.users?.phone, name: w.users?.name })) || [], total: count || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/withdrawals/:id/approve', adminAuth, async (req, res) => {
  try {
    const { data: withdrawal } = await supabase.from('withdrawals').select('*').eq('id', req.params.id).single();
    if (!withdrawal || withdrawal.status !== 'pending') return res.status(400).json({ error: 'Invalid' });
    await supabase.from('withdrawals').update({ status: 'approved', approved_at: new Date().toISOString() }).eq('id', req.params.id);
    const { data: user } = await supabase.from('users').select('total_withdraw').eq('id', withdrawal.user_id).single();
    await supabase.from('users').update({ total_withdraw: user.total_withdraw + withdrawal.amount }).eq('id', withdrawal.user_id);
    await supabase.from('transactions').insert({ user_id: withdrawal.user_id, type: 'withdraw_approved', amount: withdrawal.amount, description: 'Withdrawal approved' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/withdrawals/:id/reject', adminAuth, async (req, res) => {
  try {
    const { note } = req.body;
    const { data: withdrawal } = await supabase.from('withdrawals').select('*').eq('id', req.params.id).single();
    if (!withdrawal || withdrawal.status !== 'pending') return res.status(400).json({ error: 'Invalid' });
    await supabase.from('withdrawals').update({ status: 'rejected', note: note || 'Rejected' }).eq('id', req.params.id);
    const { data: user } = await supabase.from('users').select('withdraw_balance').eq('id', withdrawal.user_id).single();
    await supabase.from('users').update({ withdraw_balance: user.withdraw_balance + withdrawal.amount }).eq('id', withdrawal.user_id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/settings', adminAuth, async (req, res) => {
  try {
    const { data } = await supabase.from('settings').select('*');
    const obj = {};
    data?.forEach(s => obj[s.key] = s.value);
    res.json(obj);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/settings', adminAuth, upload.single('logo'), async (req, res) => {
  try {
    const data = req.body;
    if (req.file) data.site_logo = `/uploads/${req.file.filename}`;
    for (const [key, value] of Object.entries(data)) {
      await supabase.from('settings').upsert({ key, value });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const { data } = await supabase.from('settings').select('key, value');
    const obj = {};
    data?.forEach(s => obj[s.key] = s.value);
    res.json(obj);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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

app.get('/api/payment-qr/:amount', async (req, res) => {
  try {
    const { data } = await supabase.from('settings').select('value').eq('key', 'upi_id').single();
    const upiId = data?.value || 'greenpower@upi';
    const amount = req.params.amount;
    const upiString = `upi://pay?pa=${upiId}&pn=GreenPower&am=${amount}`;
    const qrCode = await QRCode.toDataURL(upiString);
    res.json({ success: true, qr: qrCode, upiId, amount });
  } catch (e) {
    res.status(400).json({ error: 'QR generation failed' });
  }
});

// Daily earnings calculator
const calculateEarnings = async () => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data: active } = await supabase.from('user_purchases')
      .select('*, users(id, withdraw_balance)').eq('status', 'active');

    for (const p of (active || [])) {
      if ((p.earned_income || 0) >= p.total_income) continue;
      const { data: paid } = await supabase.from('transactions')
        .select('id').eq('user_id', p.user_id).eq('type', 'earning').gte('created_at', today).maybeSingle();
      if (!paid) {
        const newEarned = Math.min((p.earned_income || 0) + p.daily_income, p.total_income);
        const newStatus = newEarned >= p.total_income ? 'completed' : 'active';
        const currentBalance = p.users?.withdraw_balance || 0;
        await supabase.from('users').update({ withdraw_balance: currentBalance + p.daily_income }).eq('id', p.user_id);
        await supabase.from('user_purchases').update({ earned_income: newEarned, days_remaining: Math.max((p.days_remaining || 1) - 1, 0), status: newStatus }).eq('id', p.id);
        await supabase.from('transactions').insert({ user_id: p.user_id, type: 'earning', amount: p.daily_income, description: 'Daily earning' });
      }
    }
  } catch (e) {
    console.error('Earnings calc error:', e.message);
  }
};

setInterval(calculateEarnings, 3600000);
calculateEarnings();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Green Power Server Running on port ${PORT}`);
  console.log(`📱 Supabase Connected`);
  console.log(`⚙️ Admin Panel Ready`);
});