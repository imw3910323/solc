# SOLCRASH Backend

## Setup Guide

### 1. Supabase Setup
1. Create project at https://supabase.com
2. Go to SQL Editor → paste contents of `supabase-schema.sql` → Run
3. Add this SQL function for balance credits:
```sql
CREATE OR REPLACE FUNCTION credit_user_balance(uid UUID, amount DECIMAL)
RETURNS void AS $$
BEGIN
  UPDATE users SET balance = balance + amount WHERE id = uid;
END;
$$ LANGUAGE plpgsql;
```
4. Copy: Project Settings → API → `URL` and `service_role` key

### 2. Generate Master Mnemonic (DO THIS ONCE, SAVE IT SAFELY)
```bash
npm install
node -e "const bip39=require('bip39');console.log(bip39.generateMnemonic(256))"
```
⚠️ SAVE THIS MNEMONIC IN A PASSWORD MANAGER. If lost, you lose all user deposit funds.

### 3. Environment Variables
Copy `.env.example` to `.env` and fill in:
- `SUPABASE_URL` - from Supabase dashboard
- `SUPABASE_SERVICE_KEY` - service role key (not anon key)
- `JWT_SECRET` - run: `openssl rand -hex 64`
- `MASTER_MNEMONIC` - the 24 words from step 2
- `SOLANA_RPC` - use `https://api.devnet.solana.com` for testing

### 4. Deploy to Railway
1. Push this folder to GitHub
2. Go to https://railway.app → New Project → Deploy from GitHub
3. Add environment variables in Railway dashboard
4. Deploy!

### 5. Connect Frontend
1. In `frontend-client.js`, set `BACKEND_URL` to your Railway URL
2. Add `<script src="frontend-client.js"></script>` to your HTML
3. The client automatically connects and overrides game functions

## Architecture

```
Browser → WebSocket → server.js (game loop)
Browser → REST API → server.js (auth, bets, withdrawals)
server.js → Supabase (database)
server.js → Solana RPC (deposit monitoring)
```

## Game Flow
1. Server runs countdown (20s) - bets accepted
2. Server starts round - multiplier grows
3. Server crashes at pre-calculated point
4. All WebSocket clients receive real-time updates

## Deposit Flow
1. User registers → gets unique Solana address (derived from master wallet)
2. User sends SOL to their address
3. Deposit monitor polls every 30s → credits balance
4. User gets WS notification

## Withdrawal Flow
1. User requests withdrawal → creates pending transaction
2. Admin approves in admin panel → you manually send SOL from your treasury wallet
3. User gets WS notification when approved

## Files
- `server.js` - Main Express + WebSocket server
- `game-engine.js` - Crash game logic (server-side)
- `solana-wallets.js` - HD wallet + deposit monitoring
- `frontend-client.js` - Drop into your HTML to connect
- `supabase-schema.sql` - Run in Supabase SQL editor
- `railway.toml` - Railway deployment config
