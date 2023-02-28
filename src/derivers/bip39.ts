import { mnemonicToSeed } from '@metamask/scure-bip39';
import { wordlist as englishWordlist } from '@metamask/scure-bip39/dist/wordlists/english';
import { assert, bytesToBigInt } from '@metamask/utils';
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';

import { DeriveChildKeyArgs } from '.';
import { BIP39StringNode, BYTES_KEY_LENGTH } from '../constants';
import { Curve, secp256k1 } from '../curves';
import { SLIP10Node } from '../SLIP10Node';
import { getFingerprint } from '../utils';

/**
 * Convert a BIP-39 mnemonic phrase to a multi path.
 *
 * @param mnemonic - The BIP-39 mnemonic phrase to convert.
 * @returns The multi path.
 */
export function bip39MnemonicToMultipath(mnemonic: string): BIP39StringNode {
  return `bip39:${mnemonic.toLowerCase().trim()}`;
}

/**
 * Create a {@link SLIP10Node} from a BIP-39 mnemonic phrase.
 *
 * @param options - The options for creating the node.
 * @param options.path - The multi path.
 * @param options.curve - The curve to use for derivation.
 * @returns The node.
 */
export async function deriveChildKey({
  path,
  curve,
}: DeriveChildKeyArgs): Promise<SLIP10Node> {
  return createBip39KeyFromSeed(
    await mnemonicToSeed(path, englishWordlist),
    curve,
  );
}

/**
 * Create a {@link SLIP10Node} from a BIP-39 seed.
 *
 * @param seed - The cryptographic seed bytes.
 * @param curve - The curve to use.
 * @returns An object containing the corresponding BIP-39 master key and chain
 * code.
 */
export async function createBip39KeyFromSeed(
  seed: Uint8Array,
  curve: Curve = secp256k1,
): Promise<SLIP10Node> {
  const key = hmac(sha512, curve.secret, seed);
  const privateKey = key.slice(0, BYTES_KEY_LENGTH);
  const chainCode = key.slice(BYTES_KEY_LENGTH);

  const privateKeyBigInt = bytesToBigInt(privateKey);
  assert(
    privateKeyBigInt > BigInt(0) && privateKeyBigInt < curve.curve.n,
    'Invalid private key: The private key must larger than 0 and less than the curve order.',
  );

  const masterFingerprint = getFingerprint(
    await curve.getPublicKey(privateKey, true),
  );

  return SLIP10Node.fromExtendedKey({
    privateKey,
    chainCode,
    masterFingerprint,
    depth: 0,
    parentFingerprint: 0,
    index: 0,
    curve: curve.name,
  });
}
