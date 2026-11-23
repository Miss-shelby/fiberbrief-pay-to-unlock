export type BriefPreset = {
  id: string;
  label: string;
  title: string;
  category: string;
  author: string;
  priceCkb: number;
  preview: string;
  body: string;
};

export const briefPresets: BriefPreset[] = [
  {
    id: 'fiber-routing',
    label: 'Fiber Routing Brief (1 CKB)',
    title: 'CKB Fiber Network: Multi-Hop Liquidity & Trampoline Routing Brief',
    category: 'Protocol Research',
    author: 'CKB Research Desk',
    priceCkb: 1,
    preview:
      'Free Executive Preview: Fiber channels enable sub-second off-chain CKB & UDT micropayments without waiting for L1 block confirmations. Unlock the full brief for channel reserve math, Bottle relay routing fees, and atomic preimage-to-AES key exchange architecture.',
    body: `# CKB Fiber Network: Multi-Hop Liquidity & Trampoline Routing Brief

## 1. Channel V2 Reserve & Auto-Accept Math
- Opening a 500 CKB channel reserves 100 CKB under Channel V2 rules.
- The remaining 400 CKB satisfies Bottle's auto-accept liquidity threshold, enabling immediate multi-hop routing on Testnet.

## 2. Atomic Pay-to-Decrypt Architecture
- The publisher generates a random 32-byte AES-256-GCM key and encrypts the full brief locally in the browser.
- That exact 32-byte key is supplied as the \`payment_preimage\` when minting the Fiber invoice (SHA-256 hash lock).
- Because the invoice only publishes \`payment_hash = SHA256(key)\`, no one can decrypt the ciphertext before settlement.
- Once Buyer A settles the invoice through Bottle B, the Fiber HTLC settlement atomically reveals \`payment_preimage\` — unlocking the brief with zero trusted intermediaries.

## 3. Actionable Takeaway for Builders
- Ideal for metered API responses, pay-per-article research, AI inference outputs, and encrypted file drops priced at 1–5 CKB with near-zero fees.`,
  },
  {
    id: 'rgb-security',
    label: 'UTXO & RGB++ Audit Notes (2 CKB)',
    title: 'Isomorphic Binding & UTXO Verification Checklist for CKB Builders',
    category: 'Security & Architecture',
    author: 'Nervos Security Guild',
    priceCkb: 2,
    preview:
      'Free Executive Preview: Building on CKB Cell Model and RGB++ unlocks programmable Bitcoin-anchored assets, but requires strict lock/type script verification. Unlock for the 4-point audit checklist and common testnet pitfalls.',
    body: `# Isomorphic Binding & UTXO Verification Checklist

## 1. Verify Both Lock & Type Scripts
- Never rely solely on capacity checks; always validate the exact code_hash and hash_type of referenced cells.

## 2. Guard Off-Chain Payment State Transitions
- Persist the \`payment_hash\` before calling \`sendPayment\` so page reloads recover in-flight or settled keys via \`getPayment\` without double-spending.

## 3. Never Store Decryption Keys in Plain Storage
- Keep AES-256 keys out of \`localStorage\` / \`sessionStorage\`. After reload, recover the settled preimage directly from the Fiber node's payment log.

## 4. Testnet Hygiene
- Keep Testnet funding addresses isolated from Mainnet keys and validate \`currency === 'Fibt'\` before signing or routing payments.`,
  },
  {
    id: 'micro-commerce',
    label: 'Encrypted File Drop Guide (1 CKB)',
    title: 'Zero-Backend Paywalls: Selling Encrypted Digital Downloads with Fiber',
    category: 'Builder Guide',
    author: 'Fiber Labs',
    priceCkb: 1,
    preview:
      'Free Executive Preview: Traditional digital storefronts take 10–30% fees and require accounts, KYC, and centralized servers. Unlock to see how browser-native Fiber WASM nodes turn any static file into a self-custodial paywall.',
    body: `# Zero-Backend Paywalls with Fiber WASM

## Why Preimage-Locked Files Change Digital Commerce
1. **No platform middleman:** Ciphertext can be hosted anywhere (IPFS, GitHub, CDN, or pasted as JSON) because security lives in AES-256-GCM.
2. **Instant settlement:** Micropayments settle in seconds over Fiber channels rather than waiting for L1 confirmations.
3. **Verifiable delivery:** The buyer verifies the invoice hash, amount, and expiry locally before paying, and receives the decryption key atomically upon payment completion.

Tip: Try attaching any local text, markdown, JSON, or PDF file in the Publisher Desk to test full encrypted file delivery!`,
  },
];
