// game-engine.js
// Server-side provably fair crash game engine

const crypto = require('crypto');

// ── Provably fair crash point calculation (BC.Game algorithm) ──
function generateServerSeed() {
  return crypto.randomBytes(32).toString('hex');
}

function generatePublicSeed() {
  return crypto.randomBytes(16).toString('hex');
}

function hashServerSeed(serverSeed) {
  return crypto.createHash('sha256').update(serverSeed).digest('hex');
}

function calculateCrashPoint(serverSeed, publicSeed) {
  const hmac = crypto.createHmac('sha256', serverSeed);
  hmac.update(publicSeed);
  const hash = hmac.digest('hex');

  // Check if instant bust
  const isDivisible = (h) => {
    const val = parseInt(h.slice(0, 8), 16);
    return val % 20 === 0; // ~5% instant crash
  };

  if (isDivisible(hash)) return 1.0;

  const h = parseInt(hash.slice(0, 8), 16);
  const e = Math.pow(2, 32);
  const crashPoint = Math.floor((100 * e - h) / (e - h)) / 100;
  return Math.max(1.0, crashPoint);
}

// ── Game state ──
class CrashGameEngine {
  constructor(supabase, broadcast) {
    this.supabase = supabase;
    this.broadcast = broadcast; // fn(data) sends to all WebSocket clients
    this.state = 'waiting'; // waiting | countdown | running | crashed
    this.currentRound = null;
    this.activeBets = new Map(); // userId -> { amount, cashedOut, cashoutMult, payout }
    this.startTime = null;
    this.crashPoint = null;
    this.multiplier = 1.0;
    this.gameLoop = null;
  }

  // Start the game cycle
  start() {
    console.log('🚀 Game engine started');
    this.startCountdown();
  }

  // ── Phase 1: Countdown (20 seconds, bets allowed) ──
  async startCountdown() {
    this.state = 'waiting';
    this.activeBets = new Map();
    this.multiplier = 1.0;

    // Pre-generate seeds
    const serverSeed = generateServerSeed();
    const publicSeed = generatePublicSeed();
    const hashedSeed = hashServerSeed(serverSeed);
    this.crashPoint = calculateCrashPoint(serverSeed, publicSeed);

    // Save round to DB
    const { data: round, error } = await this.supabase
      .from('rounds')
      .insert({
        server_seed: serverSeed,
        hashed_seed: hashedSeed,
        public_seed: publicSeed,
        crash_point: this.crashPoint,
        status: 'pending'
      })
      .select()
      .single();

    if (error) {
      console.error('Round create error:', error);
      setTimeout(() => this.startCountdown(), 3000);
      return;
    }

    this.currentRound = round;

    this.broadcast({
      type: 'countdown',
      roundId: round.id,
      hashedSeed,
      publicSeed,
      duration: 20000
    });

    // Wait 20 seconds
    await this.sleep(20000);
    this.startRound();
  }

  // ── Phase 2: Round running ──
  async startRound() {
    this.state = 'running';
    this.startTime = Date.now();

    // Update round status
    await this.supabase
      .from('rounds')
      .update({ status: 'active', started_at: new Date().toISOString() })
      .eq('id', this.currentRound.id);

    this.broadcast({ type: 'round_start', roundId: this.currentRound.id });

    // Tick every 100ms
    this.gameLoop = setInterval(() => this.tick(), 100);
  }

  // ── Tick: update multiplier, check crash ──
  tick() {
    const elapsed = (Date.now() - this.startTime) / 1000;
    this.multiplier = Math.pow(Math.E, 0.06 * elapsed); // growth curve

    // Broadcast current multiplier
    this.broadcast({
      type: 'multiplier',
      mult: parseFloat(this.multiplier.toFixed(4)),
      elapsed
    });

    // Check crash
    if (this.multiplier >= this.crashPoint) {
      this.doCrash();
    }
  }

  // ── Phase 3: Crash ──
  async doCrash() {
    clearInterval(this.gameLoop);
    this.state = 'crashed';
    const finalMult = this.crashPoint;

    // Bust all active (uncashed) bets
    for (const [userId, bet] of this.activeBets) {
      if (!bet.cashedOut) {
        await this.supabase
          .from('bets')
          .update({ status: 'busted', cashout_mult: null, payout: 0, profit: -bet.amount })
          .eq('round_id', this.currentRound.id)
          .eq('user_id', userId);

        await this.supabase
          .from('users')
          .update({
            games_played: this.supabase.rpc('increment', { x: 1 }),
            total_wagered: this.supabase.rpc('increment', { x: bet.amount })
          })
          .eq('id', userId);
      }
    }

    // Update round
    await this.supabase
      .from('rounds')
      .update({
        status: 'crashed',
        ended_at: new Date().toISOString()
      })
      .eq('id', this.currentRound.id);

    this.broadcast({
      type: 'crash',
      mult: finalMult,
      roundId: this.currentRound.id,
      serverSeed: this.currentRound.server_seed
    });

    // Wait 3.5 seconds then new round
    await this.sleep(3500);
    this.startCountdown();
  }

  // ── Place bet ──
  async placeBet(userId, amount) {
    if (this.state !== 'waiting') {
      return { error: "Can't place bet — round in progress" };
    }

    if (this.activeBets.has(userId)) {
      return { error: 'Bet already placed this round' };
    }

    // Check balance in DB
    const { data: user } = await this.supabase
      .from('users')
      .select('balance, username, muted_until, banned')
      .eq('id', userId)
      .single();

    if (!user) return { error: 'User not found' };
    if (user.banned) return { error: 'Account banned' };
    if (parseFloat(user.balance) < amount) return { error: 'Insufficient balance' };

    const minBet = parseFloat(process.env.MIN_BET || 0.01);
    const maxBet = parseFloat(process.env.MAX_BET || 100);
    if (amount < minBet) return { error: `Minimum bet is ${minBet} SOL` };
    if (amount > maxBet) return { error: `Maximum bet is ${maxBet} SOL` };

    // Deduct balance
    const { error: balErr } = await this.supabase
      .from('users')
      .update({ balance: parseFloat(user.balance) - amount })
      .eq('id', userId);

    if (balErr) return { error: 'Balance update failed' };

    // Save bet to DB
    const { data: bet } = await this.supabase
      .from('bets')
      .insert({
        round_id: this.currentRound.id,
        user_id: userId,
        bet_amount: amount,
        status: 'active'
      })
      .select()
      .single();

    // Track locally
    this.activeBets.set(userId, {
      amount,
      cashedOut: false,
      cashoutMult: null,
      payout: 0,
      username: user.username
    });

    // Broadcast to all clients
    this.broadcast({
      type: 'bet_placed',
      userId,
      username: user.username,
      amount
    });

    return { success: true, balance: parseFloat(user.balance) - amount };
  }

  // ── Cashout ──
  async cashout(userId) {
    if (this.state !== 'running') return { error: 'Round not active' };

    const bet = this.activeBets.get(userId);
    if (!bet) return { error: 'No active bet' };
    if (bet.cashedOut) return { error: 'Already cashed out' };

    const cashoutMult = parseFloat(this.multiplier.toFixed(4));
    const payout = parseFloat((bet.amount * cashoutMult).toFixed(8));
    const profit = parseFloat((payout - bet.amount).toFixed(8));

    // Mark cashed out
    bet.cashedOut = true;
    bet.cashoutMult = cashoutMult;
    bet.payout = payout;

    // Update DB
    await this.supabase
      .from('bets')
      .update({
        status: 'cashed',
        cashout_mult: cashoutMult,
        payout,
        profit,
        cashed_at: new Date().toISOString()
      })
      .eq('round_id', this.currentRound.id)
      .eq('user_id', userId);

    // Credit balance + update stats
    const { data: user } = await this.supabase
      .from('users')
      .select('balance, total_wagered, games_played')
      .eq('id', userId)
      .single();

    await this.supabase
      .from('users')
      .update({
        balance: parseFloat(user.balance) + payout,
        total_wagered: parseFloat(user.total_wagered || 0) + bet.amount,
        games_played: (user.games_played || 0) + 1
      })
      .eq('id', userId);

    this.broadcast({
      type: 'cashout',
      userId,
      username: bet.username,
      mult: cashoutMult,
      payout
    });

    return {
      success: true,
      mult: cashoutMult,
      payout,
      newBalance: parseFloat(user.balance) + payout
    };
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { CrashGameEngine, calculateCrashPoint, hashServerSeed };
