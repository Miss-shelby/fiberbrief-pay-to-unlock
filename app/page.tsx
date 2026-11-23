'use client';

import { channelFundingGuidance } from '../lib/channel-funding';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { scriptToAddress, type Channel, type FiberBrowserNode, type GetPaymentResult } from '@fiber-pay/sdk/browser';
import { decryptResult, toHex } from '../lib/crypto';
import { bottle, channelFundingCkb, connectAndOpenChannel, readChannel, ready, startRole } from '../lib/fiber';
import {
  createOffer,
  decodeSecretPayload,
  offerAmountShannons,
  parseOffer,
  type BriefMetadata,
  type EncryptedOffer,
  type SecretBriefPayload,
} from '../lib/offer';
import { payForOffer, validateOffer } from '../lib/payment';
import { createBrowserNodeSession } from '../lib/node-session';
import { briefPresets } from '../lib/presets';
import {
  encryptedSessionKey,
  encryptedBuyerProfile,
  encryptedSellerProfile,
  savedNodeIdentifier,
  readEncryptedProgress,
  type EncryptedLessonProgress,
} from '../lib/progress';

type Role = 'buyer' | 'seller';
type AttachmentDraft = { name: string; mime: string; size: number; base64: string };

const MAX_ATTACHMENT_BYTES = 256 * 1024; // 256 KB limit for smooth browser JSON offers
const ckb = (value: string) => `${Number(BigInt(value)) / 100_000_000}`;

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function base64ToBlob(base64: string, mime: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime || 'application/octet-stream' });
}

export default function Page() {
  const nodes = useRef<Partial<Record<Role, FiberBrowserNode>>>({});
  const sessions = useRef<Partial<Record<Role, ReturnType<typeof createBrowserNodeSession>>>>({});
  const progress = useRef<EncryptedLessonProgress | null>(null);
  const locked = useRef(false);

  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [addresses, setAddresses] = useState<Partial<Record<Role, string>>>({});
  const [connected, setConnected] = useState<Partial<Record<Role, boolean>>>({});
  const [channels, setChannels] = useState<Partial<Record<Role, Channel>>>({});

  // Publisher Desk state (Seller C)
  const initialPreset = briefPresets[0];
  const [title, setTitle] = useState(initialPreset.title);
  const [category, setCategory] = useState(initialPreset.category);
  const [author, setAuthor] = useState(initialPreset.author);
  const [priceCkb, setPriceCkb] = useState(initialPreset.priceCkb);
  const [preview, setPreview] = useState(initialPreset.preview);
  const [body, setBody] = useState(initialPreset.body);
  const [attachment, setAttachment] = useState<AttachmentDraft | null>(null);

  // Offer & Payment flow state
  const [generated, setGenerated] = useState('');
  const [received, setReceived] = useState('');
  const [offer, setOffer] = useState<EncryptedOffer | null>(null);
  const [attempt, setAttempt] = useState('');
  const [tested, setTested] = useState(false);
  const [payment, setPayment] = useState<GetPaymentResult | null>(null);
  const [key, setKey] = useState('');
  const [unlocked, setUnlocked] = useState<SecretBriefPayload | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const saved = readEncryptedProgress(sessionStorage, localStorage);
    progress.current = saved;
    if (saved) {
      setGenerated(saved.generatedOffer);
      setReceived(saved.buyerOfferText);
      setAttempt(saved.attemptedPaymentHash);
      setTested(saved.triedWithoutKey);
    }
    setLoaded(true);
    const owned = sessions.current;
    const stop = () => {
      for (const session of Object.values(owned)) void session.stop().catch(() => {});
    };
    window.addEventListener('pagehide', stop);
    return () => {
      window.removeEventListener('pagehide', stop);
      stop();
      nodes.current = {};
      sessions.current = {};
    };
  }, []);

  function save(update: Partial<EncryptedLessonProgress>) {
    const buyerId = savedNodeIdentifier(localStorage, encryptedBuyerProfile);
    const sellerId = savedNodeIdentifier(localStorage, encryptedSellerProfile);
    if (!buyerId || !sellerId) throw new Error('Start both saved nodes before continuing.');
    const next = {
      version: 1 as const,
      buyerId,
      sellerId,
      generatedOffer: '',
      buyerOfferText: '',
      attemptedPaymentHash: '',
      triedWithoutKey: false,
      ...progress.current,
      ...update,
    };
    sessionStorage.setItem(encryptedSessionKey, JSON.stringify(next));
    progress.current = next;
  }

  async function run(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Action failed. Check status before retrying a transfer.',
      );
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  async function refresh(role: Role) {
    const node = nodes.current[role];
    if (!node) return;
    const channel = await readChannel(node);
    const { peers } = await node.listPeers();
    setConnected((previous) => ({
      ...previous,
      [role]: peers.some(
        (peer) => peer.pubkey.replace(/^0x/i, '').toLowerCase() === bottle.pubkey.slice(2),
      ),
    }));
    setChannels((previous) => ({ ...previous, [role]: channel }));
  }

  async function start(role: Role) {
    if (nodes.current[role]) return;
    const session = (sessions.current[role] ??= createBrowserNodeSession());
    let started: FiberBrowserNode | undefined;
    await session.start(role === 'buyer' ? encryptedBuyerProfile : encryptedSellerProfile, async (track) => {
      started = await startRole(role, track);
    });
    if (!started) return;
    nodes.current[role] = started;
    const info = await started.nodeInfo();
    setAddresses((previous) => ({
      ...previous,
      [role]: scriptToAddress(info.default_funding_lock_script, 'testnet'),
    }));
    if (await readChannel(started)) await started.connectPeer(bottle);
    await refresh(role);
    setStatus(`${role === 'buyer' ? 'Buyer A' : 'Seller C'} node is running.`);
  }

  async function open(role: Role) {
    const node = nodes.current[role];
    if (!node) return;
    const channel = await connectAndOpenChannel(node);
    setChannels((previous) => ({ ...previous, [role]: channel }));
    await refresh(role);
    setStatus(
      channel && ready(channel)
        ? `${role === 'buyer' ? 'Buyer A' : 'Seller C'} channel is CHANNEL_READY.`
        : 'Channel opening submitted. Click Refresh Status after on-chain confirmation.',
    );
  }

  async function moveLiquidity() {
    const node = nodes.current.seller;
    if (!node) return;
    const id = savedNodeIdentifier(localStorage, encryptedSellerProfile);
    const storageKey = `fiber-docs:encrypted-inbound:${id}`;
    const existing = sessionStorage.getItem(storageKey);
    if (existing === 'submitting') {
      throw new Error('Transfer outcome unknown. Review payment history before sending again.');
    }
    let result: GetPaymentResult;
    if (existing) result = await node.getPayment({ payment_hash: existing as `0x${string}` });
    else {
      sessionStorage.setItem(storageKey, 'submitting');
      result = await node.sendPayment({
        target_pubkey: bottle.pubkey,
        amount: '0x1dcd65000',
        keysend: true,
      });
      sessionStorage.setItem(storageKey, result.payment_hash);
    }
    if (!['Success', 'Failed'].includes(result.status)) {
      result = await node.waitForPayment(result.payment_hash, { timeout: 60_000, interval: 1_000 });
    }
    if (result.status === 'Failed') sessionStorage.removeItem(storageKey);
    setStatus(`Inbound liquidity rebalance (5 CKB): ${result.status}`);
    await refresh('seller');
  }

  function applyPreset(presetId: string) {
    const found = briefPresets.find((p) => p.id === presetId);
    if (!found) return;
    setTitle(found.title);
    setCategory(found.category);
    setAuthor(found.author);
    setPriceCkb(found.priceCkb);
    setPreview(found.preview);
    setBody(found.body);
    setAttachment(null);
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      setAttachment(null);
      return;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setError(`Attachment must be under ${formatBytes(MAX_ATTACHMENT_BYTES)} for browser JSON offers.`);
      event.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : '';
      setAttachment({
        name: file.name,
        mime: file.type || 'application/octet-stream',
        size: file.size,
        base64,
      });
      setError('');
    };
    reader.readAsDataURL(file);
  }

  const requiredShannons = BigInt(priceCkb) * 100_000_000n;
  const routeReady = Boolean(
    connected.buyer &&
      connected.seller &&
      channels.buyer &&
      ready(channels.buyer) &&
      BigInt(channels.buyer.local_balance) >= requiredShannons &&
      channels.seller &&
      ready(channels.seller) &&
      BigInt(channels.seller.remote_balance) >= requiredShannons,
  );

  async function makeOffer() {
    if (!nodes.current.seller || !channels.seller || !routeReady || generated || attempt) return;
    const metadata: BriefMetadata = {
      title: title.trim() || 'Untitled Research Brief',
      category: category.trim() || 'Research',
      author: author.trim() || 'Seller C',
      preview: preview.trim(),
      priceCkb,
      ...(attachment
        ? {
            attachmentName: attachment.name,
            attachmentMime: attachment.mime,
            attachmentSize: attachment.size,
          }
        : {}),
    };
    const secret: SecretBriefPayload = {
      body,
      ...(attachment
        ? {
            attachment: {
              name: attachment.name,
              mime: attachment.mime,
              base64: attachment.base64,
            },
          }
        : {}),
    };
    const value = await createOffer(nodes.current.seller, channels.seller, secret, metadata);
    save({ generatedOffer: value });
    setGenerated(value);
    setStatus(`Encrypted brief published with a ${priceCkb} CKB Fiber Testnet invoice.`);
  }

  async function sendToBuyerAndValidate() {
    if (!generated || !nodes.current.buyer) return;
    setReceived(generated);
    setTested(false);
    const parsed = parseOffer(generated);
    await validateOffer(nodes.current.buyer, parsed);
    if (attempt && parsed.paymentHash.toLowerCase() !== attempt.toLowerCase()) {
      throw new Error('Restore the offer for the previous payment.');
    }
    save({ buyerOfferText: generated });
    setOffer(parsed);
    setStatus('Offer delivered to Buyer A and cryptographically validated against the Fiber invoice.');
  }

  async function validate() {
    if (!nodes.current.buyer) return;
    const parsed = parseOffer(received);
    await validateOffer(nodes.current.buyer, parsed);
    if (attempt && parsed.paymentHash.toLowerCase() !== attempt.toLowerCase()) {
      throw new Error('Restore the offer for the previous payment.');
    }
    save({ buyerOfferText: received });
    setOffer(parsed);
    setStatus('Offer validated: Fiber invoice currency, price, and payment hash match.');
  }

  async function testLock() {
    if (!offer) return;
    try {
      await decryptResult(offer, toHex(crypto.getRandomValues(new Uint8Array(32))));
    } catch {
      save({ triedWithoutKey: true });
      setTested(true);
      setStatus('Decryption rejected: AES-256-GCM authentication failed without the payment preimage.');
    }
  }

  function acceptPayment(result: GetPaymentResult) {
    setPayment(result);
    setStatus(`Fiber payment status: ${result.status}`);
    if (result.status === 'Failed') {
      setError(result.failed_error ?? 'Payment failed. Check channel liquidity before retrying.');
    }
    if (result.status === 'Success' && result.payment_preimage) {
      setKey(result.payment_preimage);
    }
  }

  async function pay() {
    if (!nodes.current.buyer || !offer || !tested || !routeReady) return;
    const result = await payForOffer(
      nodes.current.buyer,
      offer,
      attempt,
      (hash) => {
        save({ attemptedPaymentHash: hash });
        setAttempt(hash);
      },
      payment?.status === 'Failed',
    );
    acceptPayment(result);
    await Promise.all([refresh('buyer'), refresh('seller')]);
  }

  async function checkPayment() {
    if (!nodes.current.buyer || !offer || !attempt) return;
    await validateOffer(nodes.current.buyer, offer);
    acceptPayment(await nodes.current.buyer.getPayment({ payment_hash: attempt as `0x${string}` }));
  }

  async function unlockBrief() {
    if (!offer || !key) return;
    const rawPlaintext = await decryptResult(offer, key);
    setUnlocked(decodeSecretPayload(rawPlaintext));
    setStatus('Research brief unlocked using the revealed Fiber payment preimage!');
  }

  function startAnotherOffer() {
    if (busy || (attempt && payment?.status !== 'Failed' && !unlocked)) return;
    save({
      generatedOffer: '',
      buyerOfferText: '',
      attemptedPaymentHash: '',
      triedWithoutKey: false,
      completedSteps: [],
    });
    setGenerated('');
    setReceived('');
    setOffer(null);
    setAttempt('');
    setTested(false);
    setPayment(null);
    setKey('');
    setUnlocked(null);
    setError('');
    setStatus('Ready to publish a fresh encrypted research brief.');
  }

  const offerShannons = offer ? offerAmountShannons(offer) : requiredShannons;
  const offerPriceCkb = Number(offerShannons) / 100_000_000;
  const canSubmit = Boolean(
    offer && tested && routeReady && !key && (!attempt || payment?.status === 'Failed'),
  );

  // Stepper state
  const step1Done = routeReady;
  const step2Done = Boolean(generated);
  const step3Done = Boolean(offer && tested);
  const step4Done = Boolean(payment?.status === 'Success' && key);
  const step5Done = Boolean(unlocked);

  return (
    <main>
      <header className="hero">
        <div className="hero-top">
          <p className="eyebrow">CKB Fiber Testnet · Pay-to-Unlock Demo</p>
          <span className={`pill ${routeReady ? 'ready' : 'warn'}`}>
            {routeReady ? 'Route Ready · Bottle B Connected' : 'Setup Nodes & Channels'}
          </span>
        </div>
        <h1>FiberBrief — Pay-to-Unlock Research Desk</h1>
        <p className="subtitle">
          Publish a free public preview paired with an <strong>AES-256-GCM</strong> encrypted full report
          (and optional file attachment). Buyer A pays Seller C through Bottle B on CKB Fiber Testnet,
          and settlement atomically reveals the 32-byte preimage that unlocks the content.
        </p>
      </header>

      {/* 5-step pipeline indicator */}
      <nav className="stepper" aria-label="Workflow progress">
        <div className={`step-item ${step1Done ? 'done' : 'active'}`}>
          <span className="step-num">{step1Done ? '✓' : '1'}</span>
          <span>Nodes &amp; Channels</span>
        </div>
        <div className={`step-item ${step2Done ? 'done' : step1Done ? 'active' : ''}`}>
          <span className="step-num">{step2Done ? '✓' : '2'}</span>
          <span>Publish Brief</span>
        </div>
        <div className={`step-item ${step3Done ? 'done' : step2Done ? 'active' : ''}`}>
          <span className="step-num">{step3Done ? '✓' : '3'}</span>
          <span>Preview &amp; Lock Test</span>
        </div>
        <div className={`step-item ${step4Done ? 'done' : step3Done ? 'active' : ''}`}>
          <span className="step-num">{step4Done ? '✓' : '4'}</span>
          <span>Pay Fiber Invoice</span>
        </div>
        <div className={`step-item ${step5Done ? 'done' : step4Done ? 'active' : ''}`}>
          <span className="step-num">{step5Done ? '✓' : '5'}</span>
          <span>Key Reveal &amp; Unlock</span>
        </div>
      </nav>

      {status && (
        <p className="banner status" role="status">
          {status}
        </p>
      )}
      {error && (
        <p className="banner error" role="alert">
          {error}
        </p>
      )}

      {/* Fiber Network Topology: Buyer A <-> Bottle B <-> Seller C */}
      <section className="route-grid" aria-label="Fiber Testnet nodes">
        {(['buyer', 'seller'] as const).map((role, index) => {
          const channel = channels[role];
          const isReady = Boolean(channel && ready(channel));
          const card = (
            <div className="card" key={role}>
              <div className="card-head">
                <h2>{role === 'buyer' ? 'Buyer A (Reader)' : 'Seller C (Publisher)'}</h2>
                <span className={`pill ${isReady ? 'ready' : addresses[role] ? 'warn' : ''}`}>
                  {isReady ? 'CHANNEL_READY' : channel ? channel.state.state_name : addresses[role] ? 'Node Online' : 'Offline'}
                </span>
              </div>

              {!addresses[role] ? (
                <>
                  <p className="muted">
                    Start the browser-native Fiber WASM node to initialize its Testnet CKB address.
                  </p>
                  <button
                    className="primary"
                    disabled={!loaded || busy}
                    onClick={() => void run(() => start(role))}
                  >
                    Start {role === 'buyer' ? 'Buyer A' : 'Seller C'} Node
                  </button>
                </>
              ) : (
                <>
                  <code>{addresses[role]}</code>
                  {!channel && <p className="muted">{channelFundingGuidance}</p>}
                  {channel && (
                    <p className="muted">
                      <strong>{role === 'buyer' ? 'Buyer' : 'Seller'}:</strong> {ckb(channel.local_balance)} CKB
                      {' · '}
                      <strong>Bottle:</strong> {ckb(channel.remote_balance)} CKB
                    </p>
                  )}
                  <div className="btn-row">
                    <button
                      className="small"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await navigator.clipboard.writeText(addresses[role]!);
                          setStatus(`${role === 'buyer' ? 'Buyer A' : 'Seller C'} address copied.`);
                        })
                      }
                    >
                      Copy Address
                    </button>
                    <a
                      className="link-btn small"
                      href="https://faucet.nervos.org"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Testnet Faucet ↗
                    </a>
                    <button
                      className="small"
                      disabled={busy}
                      onClick={() => void run(() => open(role))}
                    >
                      {channel ? 'Reconnect Channel' : `Open ${channelFundingCkb} CKB Channel`}
                    </button>
                    <button
                      className="small"
                      disabled={busy}
                      onClick={() => void run(() => refresh(role))}
                    >
                      Refresh
                    </button>
                  </div>
                </>
              )}
            </div>
          );

          if (index === 0) {
            return (
              <div key="buyer-and-relay" style={{ display: 'contents' }}>
                {card}
                <div className="relay-card">
                  <span className="pill accent">Relay Hub</span>
                  <strong>Bottle B</strong>
                  <span className="relay-arrow">A ══► B ══► C</span>
                  <p className="muted" style={{ fontSize: '12px' }}>
                    Routes HTLC payments &amp; reveals preimage atomically
                  </p>
                  <button
                    className="small"
                    disabled={
                      busy ||
                      !channels.seller ||
                      !ready(channels.seller) ||
                      BigInt(channels.seller.local_balance) < 500_000_000n
                    }
                    onClick={() => void run(moveLiquidity)}
                    title="Optional: send 5 CKB from Seller C to Bottle B to increase inbound liquidity"
                  >
                    Rebalance +5 CKB Inbound
                  </button>
                </div>
              </div>
            );
          }
          return card;
        })}
      </section>

      {/* Main Exchange: Publisher Desk vs Reader Paywall */}
      <div className="grid-2">
        {/* Left: Publisher Desk (Seller C) */}
        <section className="card">
          <div className="card-head">
            <h2>1. Publisher Desk (Seller C)</h2>
            <span className="pill">AES-256-GCM + Fiber Invoice</span>
          </div>

          <div className="preset-row">
            {briefPresets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className="small"
                disabled={busy || Boolean(generated)}
                onClick={() => applyPreset(preset.id)}
              >
                {preset.label}
              </button>
            ))}
          </div>

          <div className="field">
            <label htmlFor="brief-title">Brief Title (Public)</label>
            <input
              id="brief-title"
              type="text"
              disabled={busy || Boolean(generated)}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="field-row">
            <div className="field">
              <label htmlFor="brief-category">Category</label>
              <input
                id="brief-category"
                type="text"
                disabled={busy || Boolean(generated)}
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="brief-price">Unlock Price (Testnet CKB)</label>
              <select
                id="brief-price"
                disabled={busy || Boolean(generated)}
                value={priceCkb}
                onChange={(e) => setPriceCkb(Number(e.target.value))}
              >
                <option value={1}>1 CKB</option>
                <option value={2}>2 CKB</option>
                <option value={5}>5 CKB</option>
              </select>
            </div>
          </div>

          <div className="field">
            <label htmlFor="brief-preview">Free Public Preview (Visible Before Payment)</label>
            <textarea
              id="brief-preview"
              disabled={busy || Boolean(generated)}
              value={preview}
              onChange={(e) => setPreview(e.target.value)}
              style={{ minHeight: '78px' }}
            />
          </div>

          <div className="field">
            <label htmlFor="brief-body">Locked Full Brief (Encrypted with AES-256-GCM)</label>
            <textarea
              id="brief-body"
              disabled={busy || Boolean(generated)}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              style={{ minHeight: '150px' }}
            />
          </div>

          <div className="field">
            <label htmlFor="brief-file">Optional Encrypted File Attachment (≤ 256 KB)</label>
            <div className="file-drop">
              <input
                id="brief-file"
                type="file"
                disabled={busy || Boolean(generated)}
                onChange={handleFileChange}
              />
              {attachment && (
                <span>
                  {attachment.name} ({formatBytes(attachment.size)})
                </span>
              )}
            </div>
          </div>

          <div className="btn-row">
            <button
              className="primary"
              disabled={busy || !routeReady || !body.trim() || Boolean(generated || attempt)}
              onClick={() => void run(makeOffer)}
            >
              Encrypt &amp; Publish ({priceCkb} CKB Invoice)
            </button>
            {generated && (
              <>
                <button
                  className="primary"
                  disabled={busy || !addresses.buyer || Boolean(offer)}
                  onClick={() => void run(sendToBuyerAndValidate)}
                >
                  Send to Buyer Preview →
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await navigator.clipboard.writeText(generated);
                      setStatus('Public encrypted offer JSON copied to clipboard.');
                    })
                  }
                >
                  Copy Offer JSON
                </button>
              </>
            )}
          </div>

          {generated && (
            <details>
              <summary>Inspect Public Encrypted Offer JSON (safe to share)</summary>
              <textarea
                aria-label="Generated offer"
                className="mono"
                readOnly
                value={generated}
                style={{ marginTop: '10px', minHeight: '120px' }}
              />
            </details>
          )}
        </section>

        {/* Right: Reader Paywall (Buyer A) */}
        <section className="card">
          <div className="card-head">
            <h2>2. Reader Paywall (Buyer A)</h2>
            <span className={`pill ${unlocked ? 'ready' : offer ? 'accent' : ''}`}>
              {unlocked ? 'Unlocked' : offer ? `Locked · ${offerPriceCkb} CKB` : 'Awaiting Offer'}
            </span>
          </div>

          {!offer && (
            <>
              <div className="field">
                <label htmlFor="received-offer">Paste Encrypted Offer JSON (or click “Send to Buyer Preview”)</label>
                <textarea
                  id="received-offer"
                  className="mono"
                  placeholder='{"version": 2, "cipher": "AES-256-GCM", ...}'
                  disabled={busy || Boolean(offer || attempt)}
                  value={received}
                  onChange={(e) => {
                    setReceived(e.target.value);
                    setTested(false);
                  }}
                />
              </div>
              <button
                className="primary"
                disabled={busy || !received || !addresses.buyer || Boolean(offer)}
                onClick={() => void run(validate)}
              >
                Validate Offer &amp; Load Preview
              </button>
            </>
          )}

          {offer && (
            <div className="preview-box">
              <div className="preview-meta">
                <span className="pill accent">{offer.metadata?.category ?? 'Encrypted Brief'}</span>
                <span className="pill">{offerPriceCkb} Testnet CKB</span>
              </div>
              <h3>{offer.metadata?.title ?? 'Encrypted Fiber Offer'}</h3>
              <p className="muted">
                By <strong>{offer.metadata?.author ?? 'Seller C'}</strong>
                {offer.metadata?.attachmentName
                  ? ` · Includes encrypted file: ${offer.metadata.attachmentName}`
                  : ''}
              </p>
              {offer.metadata?.preview && <p className="preview-text">{offer.metadata.preview}</p>}

              {!unlocked ? (
                <div className="locked-veil">
                  <div className="locked-fake-lines" aria-hidden="true">
                    ## Full Research Analysis &amp; Technical Findings
                    <br />
                    • Channel liquidity reserve calculations and Bottle routing optimization...
                    <br />
                    • Cryptographic preimage binding verified via SHA-256 HTLC settlement...
                    <br />
                    • Complete implementation checklist and downloadable encrypted payload...
                  </div>
                  <div className="locked-overlay">
                    <strong>
                      {tested
                        ? 'Lock Verified · Ready for Fiber Payment'
                        : 'Encrypted with AES-256-GCM'}
                    </strong>
                    <span className="muted" style={{ fontSize: '12px' }}>
                      {tested
                        ? `Pay ${offerPriceCkb} CKB via Fiber to reveal the 32-byte decryption key.`
                        : 'Test decryption without the key first to verify the paywall.'}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="unlocked-article">
                  <div className="card-head" style={{ marginBottom: '12px' }}>
                    <span className="pill ready">Decrypted with Revealed Preimage</span>
                    <div className="btn-row">
                      <button
                        className="small"
                        onClick={() =>
                          downloadBlob(
                            new Blob([unlocked.body], { type: 'text/markdown;charset=utf-8' }),
                            `${(offer.metadata?.title ?? 'fiber-brief').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`,
                          )
                        }
                      >
                        Download .md
                      </button>
                      {unlocked.attachment && (
                        <button
                          className="small primary"
                          onClick={() =>
                            downloadBlob(
                              base64ToBlob(unlocked.attachment!.base64, unlocked.attachment!.mime),
                              unlocked.attachment!.name,
                            )
                          }
                        >
                          Download {unlocked.attachment.name}
                        </button>
                      )}
                    </div>
                  </div>
                  <pre>{unlocked.body}</pre>
                </div>
              )}

              {/* Buyer Action Controls */}
              <div className="btn-row">
                {!tested && (
                  <button
                    className="primary"
                    disabled={busy || !offer}
                    onClick={() => void run(testLock)}
                  >
                    Step A: Decrypt Without Key (Verify Lock)
                  </button>
                )}
                {canSubmit && (
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() => void run(pay)}
                  >
                    {attempt
                      ? 'Retry Failed Payment'
                      : `Step B: Pay ${offerPriceCkb} CKB via Fiber`}
                  </button>
                )}
                {attempt && !key && (
                  <button
                    disabled={busy || !offer || !addresses.buyer}
                    onClick={() => void run(checkPayment)}
                  >
                    Check Payment Status
                  </button>
                )}
                {key && !unlocked && (
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() => void run(unlockBrief)}
                  >
                    Step C: Decrypt Brief with Revealed Key
                  </button>
                )}
              </div>
            </div>
          )}

          {(generated || received) && (!attempt || payment?.status === 'Failed' || Boolean(unlocked)) && (
            <button
              className="small"
              disabled={busy}
              onClick={() => void run(async () => startAnotherOffer())}
            >
              Start Another Brief
            </button>
          )}
        </section>
      </div>

      {/* Verified Fiber Receipt & Cryptographic Key Audit */}
      {payment?.status === 'Success' && (
        <section className="card">
          <div className="card-head">
            <h2>Verified Fiber Payment Receipt &amp; Key Reveal</h2>
            <span className="pill ready">Settled on CKB Fiber Testnet</span>
          </div>
          <div className="receipt-grid">
            <div className="metric">
              <span>Brief Price</span>
              <strong>{offerPriceCkb} CKB</strong>
            </div>
            <div className="metric">
              <span>Routing Fee (Bottle B)</span>
              <strong>{ckb(payment.fee)} CKB</strong>
            </div>
            <div className="metric">
              <span>Total Paid</span>
              <strong>
                {ckb(`0x${(offerShannons + BigInt(payment.fee)).toString(16)}`)} CKB
              </strong>
            </div>
          </div>
          <div className="field">
            <label>Payment Hash (SHA-256 of Decryption Key)</label>
            <code>{payment.payment_hash}</code>
          </div>
          {key && (
            <div className="field">
              <label>Revealed Payment Preimage (= 32-Byte AES-256-GCM Decryption Key)</label>
              <code>{key}</code>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
