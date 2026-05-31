// solana-wallets.js
// Generates unique Solana deposit address for each user
// Uses BIP44 HD derivation from master mnemonic

const { derivePath } = require('ed25519-hd-key');
const { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bip39 = require('bip39');
const nacl = require('tweetnacl');

const connection = new Connection(process.env.SOLANA_RPC || 'https://api.devnet.solana.com', 'confirmed');

// Derive a unique keypair for a user based on their index
function deriveUserKeypair(userIndex) {
  const mnemonic = process.env.MASTER_MNEMONIC;
  if (!mnemonic) throw new Error('MASTER_MNEMONIC not set');

  const seed = bip39.mnemonicToSeedSync(mnemonic);
  // BIP44 path for Solana: m/44'/501'/userIndex'/0'
  const path = `m/44'/501'/${userIndex}'/0'`;
  const derived = derivePath(path, seed.toString('hex'));
  const keypair = Keypair.fromSeed(derived.key);
  return keypair;
}

// Get deposit address for a user index
function getUserDepositAddress(userIndex) {
  const keypair = deriveUserKeypair(userIndex);
  return keypair.publicKey.toString();
}

// Get the next available index from DB
async function getNextDepositIndex(supabase) {
  const { data, error } = await supabase
    .from('users')
    .select('deposit_index')
    .order('deposit_index', { ascending: false })
    .limit(1);

  if (error || !data || data.length === 0) return 0;
  return (data[0].deposit_index || 0) + 1;
}

// Monitor a user's deposit address for incoming SOL
async function checkDeposits(supabase, user) {
  try {
    const pubkey = new PublicKey(user.deposit_address);
    const signatures = await connection.getSignaturesForAddress(pubkey, { limit: 10 });

    for (const sigInfo of signatures) {
      // Check if already processed
      const { data: existing } = await supabase
        .from('deposit_monitor')
        .select('id')
        .eq('tx_signature', sigInfo.signature)
        .single();

      if (existing) continue;

      // Get transaction details
      const tx = await connection.getParsedTransaction(sigInfo.signature, {
        maxSupportedTransactionVersion: 0
      });

      if (!tx || !tx.meta) continue;

      // Find transfer to user's deposit address
      const accountKeys = tx.transaction.message.accountKeys;
      const userIndex = accountKeys.findIndex(k => k.pubkey.toString() === user.deposit_address);

      if (userIndex === -1) continue;

      const preBalance = tx.meta.preBalances[userIndex] || 0;
      const postBalance = tx.meta.postBalances[userIndex] || 0;
      const depositLamports = postBalance - preBalance;

      if (depositLamports <= 0) continue;

      const depositSOL = depositLamports / LAMPORTS_PER_SOL;

      // Record in deposit_monitor
      await supabase.from('deposit_monitor').insert({
        user_id: user.id,
        tx_signature: sigInfo.signature,
        amount: depositSOL,
        confirmed: true
      });

      // Credit user balance
      const { error: balErr } = await supabase.rpc('credit_user_balance', {
        uid: user.id,
        amount: depositSOL
      });

      if (!balErr) {
        // Record transaction
        await supabase.from('transactions').insert({
          user_id: user.id,
          type: 'deposit',
          amount: depositSOL,
          status: 'completed',
          tx_hash: sigInfo.signature
        });

        console.log(`✓ Deposit: ${depositSOL} SOL → user ${user.username} (${sigInfo.signature})`);
      }
    }
  } catch (err) {
    console.error('Deposit check error:', err.message);
  }
}

// Poll all users for deposits every 30 seconds
async function startDepositMonitor(supabase, wss) {
  console.log('💰 Deposit monitor started');

  async function poll() {
    try {
      const { data: users } = await supabase
        .from('users')
        .select('id, username, deposit_address, balance')
        .not('deposit_address', 'is', null);

      if (!users) return;

      for (const user of users) {
        const prevBalance = user.balance;
        await checkDeposits(supabase, user);

        // Check if balance changed and notify user
        const { data: updated } = await supabase
          .from('users')
          .select('balance')
          .eq('id', user.id)
          .single();

        if (updated && updated.balance > prevBalance) {
          const depositAmt = updated.balance - prevBalance;
          // Notify via WebSocket if user is connected
          if (wss) {
            wss.clients.forEach(client => {
              if (client.userId === user.id && client.readyState === 1) {
                client.send(JSON.stringify({
                  type: 'deposit',
                  amount: depositAmt,
                  balance: updated.balance
                }));
              }
            });
          }
        }
      }
    } catch (err) {
      console.error('Poll error:', err.message);
    }
  }

  // Run immediately then every 30 seconds
  poll();
  setInterval(poll, 30000);
}

module.exports = {
  getUserDepositAddress,
  getNextDepositIndex,
  deriveUserKeypair,
  startDepositMonitor
};