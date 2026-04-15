import { Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

export function loadWallet(): Keypair | null {
  const raw = (process.env.PRIVATE_KEY ?? '').trim();
  if (raw === '') return null;
  const secret = bs58.decode(raw);
  return Keypair.fromSecretKey(secret);
}

export function signTransaction(base64Tx: string, wallet: Keypair): string {
  const buf = Buffer.from(base64Tx, 'base64');
  const transaction = VersionedTransaction.deserialize(buf);
  transaction.sign([wallet]);
  return Buffer.from(transaction.serialize()).toString('base64');
}
