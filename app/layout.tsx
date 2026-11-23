import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'FiberBrief — Pay-to-Unlock Research & Encrypted Files on CKB Fiber',
  description:
    'A browser-native CKB Fiber Testnet paywall demo: publish a free preview with an AES-256-GCM encrypted research brief or file, pay via Fiber, and unlock with the revealed payment preimage.',
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
