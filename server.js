// server.js - SOLCRASH Backend
// Express REST API + WebSocket real-time game

require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const { CrashGameEngine, calculateCrashPoint, hashServerSeed } = require('./game-engine');
const { getUserDepositAddress, getNextDepositIndex, startDepositMonitor } = require('./solana-wallets');

// ── Init ──
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.use(express.json());

// ── Chat history (last 100 messages in memory) ──
const chatHistory = [];
const MAX_CHAT = 100;

// ── Connected clients ──
// client.userId, client.username, client.role

// ── Broadcast to all WS clients ──
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// ── Game engine ──
const game = new CrashGameEngine(supabase, broadcast);

// ════════════════════════════════════════
// AUTH MIDDLEWARE
// ════════════════════════════════════════
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function adminMiddleware(req, res, next) {
  if (!['mod', 'owner'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// ════════════════════════════════════════
// AUTH ROUTES
// ════════════════════════════════════════

// Register
app.post('/api/auth/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'Missing fields' });
  if (username.length < 3 || username.length > 20) return res.status(400).json({ error: 'Username must be 3-20 chars' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be 6+ chars' });

  try {
    // Check unique
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .or(`username.eq.${username},email.eq.${email}`)
      .limit(1);

    if (existing?.length > 0) return res.status(409).json({ error: 'Username or email already taken' });

    // Generate deposit address
    const depositIndex = await getNextDepositIndex(supabase);
    const depositAddress = getUserDepositAddress(depositIndex);

    const passwordHash = await bcrypt.hash(password, 12);
    const shortId = Math.random().toString(36).substr(2, 6).toUpperCase();

    const { data: user, error } = await supabase
      .from('users')
      .insert({
        username,
        email,
        password_hash: passwordHash,
        deposit_address: depositAddress,
        deposit_index: depositIndex,
        balance: 0
      })
      .select('id, username, email, balance, level, xp, role, pfp_url, deposit_address, created_at')
      .single();

    if (error) return res.status(500).json({ error: 'Registration failed' });

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({ token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Missing fields' });

  const { data: user } = await supabase
    .from('users')
    .select('*')
    .eq('email', email.toLowerCase())
    .single();

  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (user.banned) return res.status(403).json({ error: 'Account banned' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );

  const { password_hash, ...safeUser } = user;
  res.json({ token, user: safeUser });
});

// Get current user
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  const { data: user } = await supabase
    .from('users')
    .select('id, username, email, balance, level, xp, role, pfp_url, deposit_address, anonymous_mode, private_profile, total_deposited, total_wagered, games_played, created_at')
    .eq('id', req.user.id)
    .single();

  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

// ════════════════════════════════════════
// USER ROUTES
// ════════════════════════════════════════

// Update profile
app.patch('/api/user/profile', authMiddleware, async (req, res) => {
  const { username, pfp_url, anonymous_mode, private_profile, client_seed } = req.body;
  const updates = {};

  if (username) {
    if (username.length < 3 || username.length > 20) return res.status(400).json({ error: 'Username 3-20 chars' });
    const { data: exists } = await supabase.from('users').select('id').eq('username', username).single();
    if (exists && exists.id !== req.user.id) return res.status(409).json({ error: 'Username taken' });
    updates.username = username;
  }
  if (pfp_url !== undefined) updates.pfp_url = pfp_url;
  if (anonymous_mode !== undefined) updates.anonymous_mode = anonymous_mode;
  if (private_profile !== undefined) updates.private_profile = private_profile;

  const { data: user, error } = await supabase
    .from('users')
    .update(updates)
    .eq('id', req.user.id)
    .select('id, username, pfp_url, anonymous_mode, private_profile')
    .single();

  if (error) return res.status(500).json({ error: 'Update failed' });
  res.json(user);
});

// Get transactions
app.get('/api/user/transactions', authMiddleware, async (req, res) => {
  const { data } = await supabase
    .from('transactions')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(50);
  res.json(data || []);
});

// Get bet history
app.get('/api/user/bets', authMiddleware, async (req, res) => {
  const { data } = await supabase
    .from('bets')
    .select('*, rounds(crash_point, public_seed, hashed_seed, server_seed)')
    .eq('user_id', req.user.id)
    .order('placed_at', { ascending: false })
    .limit(50);
  res.json(data || []);
});

// ════════════════════════════════════════
// GAME ROUTES
// ════════════════════════════════════════

// Get recent rounds
app.get('/api/game/history', async (req, res) => {
  const { data } = await supabase
    .from('rounds')
    .select('id, crash_point, hashed_seed, public_seed, server_seed, started_at')
    .eq('status', 'crashed')
    .order('started_at', { ascending: false })
    .limit(20);
  res.json(data || []);
});

// Verify fairness
app.post('/api/game/verify', async (req, res) => {
  const { serverSeed, publicSeed } = req.body;
  if (!serverSeed || !publicSeed) return res.status(400).json({ error: 'Missing seeds' });

  const hashedSeed = hashServerSeed(serverSeed);
  const crashPoint = calculateCrashPoint(serverSeed, publicSeed);
  res.json({ hashedSeed, crashPoint });
});

// ════════════════════════════════════════
// WITHDRAWAL ROUTES
// ════════════════════════════════════════
app.post('/api/withdraw', authMiddleware, async (req, res) => {
  const { amount, address } = req.body;
  if (!amount || !address) return res.status(400).json({ error: 'Missing fields' });

  const { data: user } = await supabase
    .from('users')
    .select('balance')
    .eq('id', req.user.id)
    .single();

  if (!user || parseFloat(user.balance) < amount) {
    return res.status(400).json({ error: 'Insufficient balance' });
  }

  const minWithdraw = 0.01;
  if (amount < minWithdraw) return res.status(400).json({ error: `Minimum withdrawal: ${minWithdraw} SOL` });

  // Deduct balance
  await supabase
    .from('users')
    .update({ balance: parseFloat(user.balance) - amount })
    .eq('id', req.user.id);

  // Record transaction (pending - admin approves)
  const { data: tx } = await supabase
    .from('transactions')
    .insert({
      user_id: req.user.id,
      type: 'withdrawal',
      amount,
      status: 'pending',
      to_address: address
    })
    .select()
    .single();

  res.json({ success: true, transaction: tx });
});

// ════════════════════════════════════════
// PROMO CODES
// ════════════════════════════════════════
app.post('/api/promo/redeem', authMiddleware, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Missing code' });

  const { data: promo } = await supabase
    .from('promo_codes')
    .select('*')
    .eq('code', code.toUpperCase())
    .single();

  if (!promo) return res.status(404).json({ error: 'Invalid promo code' });
  if (promo.uses >= promo.max_uses) return res.status(400).json({ error: 'Promo code expired' });
  if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
    return res.status(400).json({ error: 'Promo code expired' });
  }

  // Check if already redeemed
  const { data: already } = await supabase
    .from('promo_redemptions')
    .select('id')
    .eq('user_id', req.user.id)
    .eq('promo_id', promo.id)
    .single();

  if (already) return res.status(400).json({ error: 'Already redeemed this code' });

  // Redeem
  await supabase.from('promo_redemptions').insert({ user_id: req.user.id, promo_id: promo.id });
  await supabase.from('promo_codes').update({ uses: promo.uses + 1 }).eq('id', promo.id);

  const { data: user } = await supabase.from('users').select('balance').eq('id', req.user.id).single();
  await supabase.from('users').update({ balance: parseFloat(user.balance) + promo.amount }).eq('id', req.user.id);

  await supabase.from('transactions').insert({
    user_id: req.user.id,
    type: 'promo',
    amount: promo.amount,
    status: 'completed',
    note: code
  });

  res.json({ success: true, amount: promo.amount });
});

// ════════════════════════════════════════
// TIP ROUTES
// ════════════════════════════════════════
app.post('/api/tip', authMiddleware, async (req, res) => {
  const { toUsername, amount } = req.body;
  if (!toUsername || !amount) return res.status(400).json({ error: 'Missing fields' });
  if (amount < 0.01) return res.status(400).json({ error: 'Minimum tip: 0.01 SOL' });

  const { data: sender } = await supabase.from('users').select('balance, username').eq('id', req.user.id).single();
  const { data: receiver } = await supabase.from('users').select('id, username').eq('username', toUsername).single();

  if (!receiver) return res.status(404).json({ error: 'User not found' });
  if (receiver.id === req.user.id) return res.status(400).json({ error: 'Cannot tip yourself' });
  if (parseFloat(sender.balance) < amount) return res.status(400).json({ error: 'Insufficient balance' });

  // Transfer
  await supabase.from('users').update({ balance: parseFloat(sender.balance) - amount }).eq('id', req.user.id);
  const { data: recv } = await supabase.from('users').select('balance').eq('id', receiver.id).single();
  await supabase.from('users').update({ balance: parseFloat(recv.balance) + amount }).eq('id', receiver.id);

  await supabase.from('tips').insert({ from_user_id: req.user.id, to_user_id: receiver.id, amount });
  await supabase.from('transactions').insert([
    { user_id: req.user.id, type: 'tip', amount, status: 'completed', note: `Tip to ${toUsername}` },
    { user_id: receiver.id, type: 'tip', amount, status: 'completed', note: `Tip from ${sender.username}` }
  ]);

  // Notify receiver via WS
  wss.clients.forEach(client => {
    if (client.userId === receiver.id && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'tip_received', from: sender.username, amount }));
    }
  });

  broadcast({ type: 'chat_tip', from: sender.username, to: toUsername, amount });
  res.json({ success: true });
});

// ════════════════════════════════════════
// ADMIN ROUTES
// ════════════════════════════════════════

// Get all users
app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  const { data } = await supabase
    .from('users')
    .select('id, username, email, balance, level, role, banned, muted_until, deposit_address, total_wagered, games_played, created_at')
    .order('created_at', { ascending: false });
  res.json(data || []);
});

// Update user
app.patch('/api/admin/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  const { balance, level, role, banned, muted_until, ban_reason, mute_reason } = req.body;
  const updates = {};

  if (balance !== undefined) updates.balance = balance;
  if (level !== undefined) updates.level = Math.min(200, Math.max(1, level));
  if (role !== undefined && req.user.role === 'owner') updates.role = role;
  if (banned !== undefined) updates.banned = banned;
  if (muted_until !== undefined) updates.muted_until = muted_until;
  if (ban_reason !== undefined) updates.ban_reason = ban_reason;
  if (mute_reason !== undefined) updates.mute_reason = mute_reason;

  const { data, error } = await supabase.from('users').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: 'Update failed' });

  // Log action
  await supabase.from('admin_logs').insert({
    admin_id: req.user.id,
    target_user_id: req.params.id,
    action: Object.keys(updates).join(', '),
    detail: JSON.stringify(updates)
  });

  res.json(data);
});

// Get admin logs
app.get('/api/admin/logs', authMiddleware, adminMiddleware, async (req, res) => {
  const { data } = await supabase
    .from('admin_logs')
    .select('*, admin:admin_id(username), target:target_user_id(username)')
    .order('created_at', { ascending: false })
    .limit(100);
  res.json(data || []);
});

// Get all transactions
app.get('/api/admin/transactions', authMiddleware, adminMiddleware, async (req, res) => {
  const type = req.query.type;
  let query = supabase
    .from('transactions')
    .select('*, user:user_id(username, deposit_address)')
    .order('created_at', { ascending: false })
    .limit(100);
  if (type) query = query.eq('type', type);
  const { data } = await query;
  res.json(data || []);
});

// Approve/reject withdrawal
app.patch('/api/admin/transactions/:id', authMiddleware, adminMiddleware, async (req, res) => {
  const { status } = req.body;
  const { data } = await supabase
    .from('transactions')
    .update({ status, completed_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select('*, user:user_id(username, id)')
    .single();

  if (status === 'completed' && data?.user) {
    wss.clients.forEach(client => {
      if (client.userId === data.user.id) {
        client.send(JSON.stringify({ type: 'withdrawal_accepted', amount: data.amount }));
      }
    });
  }

  res.json(data);
});

// Create promo code
app.post('/api/admin/promos', authMiddleware, adminMiddleware, async (req, res) => {
  const { code, amount, max_uses, expires_at } = req.body;
  const { data, error } = await supabase
    .from('promo_codes')
    .insert({ code: code.toUpperCase(), amount, max_uses: max_uses || 1, expires_at })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// ════════════════════════════════════════
// WEBSOCKET HANDLER
// ════════════════════════════════════════
wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.userId = null;
  ws.username = null;
  ws.role = 'user';

  // Send initial state
  ws.send(JSON.stringify({
    type: 'init',
    gameState: game.state,
    multiplier: game.multiplier,
    chatHistory: chatHistory.slice(-50)
  }));

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── Auth ──
      case 'auth': {
        try {
          const decoded = jwt.verify(msg.token, process.env.JWT_SECRET);
          ws.userId = decoded.id;
          ws.username = decoded.username;
          ws.role = decoded.role;

          // Get fresh user data
          const { data: user } = await supabase
            .from('users')
            .select('balance, level, xp, banned, muted_until')
            .eq('id', decoded.id)
            .single();

          ws.send(JSON.stringify({ type: 'auth_ok', user }));
        } catch {
          ws.send(JSON.stringify({ type: 'auth_error', error: 'Invalid token' }));
        }
        break;
      }

      // ── Place bet ──
      case 'bet': {
        if (!ws.userId) return ws.send(JSON.stringify({ type: 'error', error: 'Not authenticated' }));
        const result = await game.placeBet(ws.userId, parseFloat(msg.amount));
        ws.send(JSON.stringify({ type: 'bet_result', ...result }));
        break;
      }

      // ── Cashout ──
      case 'cashout': {
        if (!ws.userId) return ws.send(JSON.stringify({ type: 'error', error: 'Not authenticated' }));
        const result = await game.cashout(ws.userId);
        ws.send(JSON.stringify({ type: 'cashout_result', ...result }));
        break;
      }

      // ── Chat ──
      case 'chat': {
        if (!ws.userId) return ws.send(JSON.stringify({ type: 'error', error: 'Not authenticated' }));
        if (!msg.text || msg.text.length > 200) return;

        // Check mute
        const { data: user } = await supabase
          .from('users')
          .select('muted_until, banned, username, role, level, pfp_url, anonymous_mode')
          .eq('id', ws.userId)
          .single();

        if (user.banned) return;
        if (user.muted_until && new Date(user.muted_until) > new Date()) {
          ws.send(JSON.stringify({ type: 'muted', until: user.muted_until }));
          return;
        }

        const chatMsg = {
          id: uuidv4(),
          userId: ws.userId,
          username: user.anonymous_mode ? 'Anonymous' : user.username,
          text: msg.text.slice(0, 200),
          role: user.role,
          level: user.level,
          avatar: user.pfp_url,
          ts: Date.now()
        };

        chatHistory.push(chatMsg);
        if (chatHistory.length > MAX_CHAT) chatHistory.shift();

        // Save to DB
        await supabase.from('chat_messages').insert({
          user_id: ws.userId,
          message: msg.text
        });

        broadcast({ type: 'chat', message: chatMsg });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (ws.username) {
      broadcast({ type: 'player_left', username: ws.username });
    }
  });
});

// ── Heartbeat (detect dead connections) ──
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// ════════════════════════════════════════
// START
// ════════════════════════════════════════
const PORT = process.env.PORT || 3001;
server.listen(PORT, async () => {
  console.log(`🚀 SOLCRASH server running on port ${PORT}`);

  // Start game engine
  game.start();

  // Start deposit monitor
  startDepositMonitor(supabase, wss);
});

module.exports = { app, server };