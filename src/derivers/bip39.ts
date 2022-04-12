import { mnemonicToSeedSync } from '@scure/bip39';
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';
import { BIP39Node } from '../constants';
import { Curve, secp256k1 } from '../curves';

/**
 * @param mnemonic
 */
export function bip39MnemonicToMultipath(mnemonic: string): BIP39Node {
  return `bip39:${mnemonic.toLowerCase().trim()}`;
}

// this creates a child key using bip39, ignoring the parent key
/**
 * @param pathPart
 * @param _parentKey
 * @param _parentPublicKey
 * @param _chainCode
 * @param curve
 */
export async function deriveChildKey(
  pathPart: string,
  _parentKey?: never,
  _parentPublicKey?: never,
  _chainCode?: never,
  curve: Curve = secp256k1,
): Promise<[privateKey: Buffer, publicKey: Buffer, chainCode: Buffer]> {
  return createBip39KeyFromSeed(
    Buffer.from(mnemonicToSeedSync(pathPart)),
    curve,
  );
}

/**
 * @param seed - The cryptographic seed bytes.
 * @param curve - The curve to use.
 * @returns The bytes of the corresponding BIP-39 master key.
 */
export async function createBip39KeyFromSeed(
  seed: Buffer,
  curve: Curve = secp256k1,
): Promise<[privateKey: Buffer, publicKey: Buffer, chainCode: Buffer]> {
  const key = Buffer.from(hmac(sha512, curve.secret, seed));

  const privateKey = key.slice(0, 32);

  return [privateKey, await curve.getPublicKey(privateKey), key.slice(32, 64)];
}
