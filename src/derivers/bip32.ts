import { keccak_256 as keccak256 } from '@noble/hashes/sha3';
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';
import { BIP_32_HARDENED_OFFSET, BUFFER_KEY_LENGTH } from '../constants';
import { bytesToNumber, hexStringToBuffer, isValidBufferKey } from '../utils';
import { Curve, mod, secp256k1 } from '../curves';

export function privateKeyToEthAddress(key: Buffer) {
  if (!Buffer.isBuffer(key) || !isValidBufferKey(key, 32)) {
    throw new Error('Invalid key: The key must be a 32-byte, non-zero Buffer.');
  }

  const publicKey = secp256k1.getPublicKey(key, false);
  return publicKeyToEthAddress(publicKey);
}

/**
 * Converts a BIP-32 public key to an Ethereum address.
 *
 * **WARNING:** Only validates that the key is non-zero and of the correct
 * length. It is the consumer's responsibility to ensure that the specified
 * key is a valid BIP-44 Ethereum `address_index` key.
 *
 * @param key - The `address_index` public key buffer to convert to an Ethereum
 * address.
 * @returns The Ethereum address corresponding to the given key.
 */
export function publicKeyToEthAddress(key: Buffer) {
  if (!Buffer.isBuffer(key) || !isValidBufferKey(key, 65)) {
    throw new Error('Invalid key: The key must be a 65-byte, non-zero Buffer.');
  }

  return Buffer.from(keccak256(key.slice(1)).slice(-20));
}

/**
 * @param pathPart
 * @param parentKey
 * @param parentPublicKey
 * @param chainCode
 * @param curve
 */
export async function deriveChildKey(
  pathPart: string,
  parentKey: Buffer | undefined,
  parentPublicKey: Buffer | undefined,
  chainCode: Buffer,
  curve: Curve = secp256k1,
): Promise<[privateKey: Buffer, publicKey: Buffer, chainCode: Buffer]> {
  const isHardened = pathPart.includes(`'`);
  if (!isHardened && !curve.deriveUnhardenedKeys) {
    throw new Error(
      `Invalid path: Cannot derive unhardened child keys with ${curve.name}.`,
    );
  }

  if (!parentKey && !parentPublicKey) {
    throw new Error(
      'Invalid parameters: Must specify either a parent private or public key.',
    );
  }

  if (!chainCode) {
    throw new Error('Invalid parameters: Must specify a chain code.');
  }

  if (parentKey?.length !== BUFFER_KEY_LENGTH) {
    throw new Error('Invalid parent key: Must be 32 bytes long.');
  }

  if (chainCode.length !== BUFFER_KEY_LENGTH) {
    throw new Error('Invalid chain code: Must be 32 bytes long.');
  }

  const indexPart = pathPart.split(`'`)[0];
  const childIndex = parseInt(indexPart, 10);

  if (
    !/^\d+$/u.test(indexPart) ||
    !Number.isInteger(childIndex) ||
    childIndex < 0 ||
    childIndex >= BIP_32_HARDENED_OFFSET
  ) {
    throw new Error(
      `Invalid BIP-32 index: The index must be a non-negative decimal integer less than ${BIP_32_HARDENED_OFFSET}.`,
    );
  }

  const secretExtension = await deriveSecretExtension({
    parentPrivateKey: parentKey,
    childIndex,
    isHardened,
    curve,
  });

  const { privateKey, extraEntropy } = generateKey({
    parentPrivateKey: parentKey,
    parentExtraEntropy: chainCode,
    secretExtension,
    curve,
  });

  return [
    Buffer.from(privateKey),
    await curve.getPublicKey(privateKey),
    Buffer.from(extraEntropy),
  ];
}

type DeriveSecretExtensionArgs = {
  parentPrivateKey: Buffer;
  childIndex: number;
  isHardened: boolean;
  curve: Curve;
};

// the bip32 secret extension is created from the parent private or public key and the child index
/**
 * @param options
 * @param options.parentPrivateKey
 * @param options.childIndex
 * @param options.isHardened
 */
async function deriveSecretExtension({
  parentPrivateKey,
  childIndex,
  isHardened,
  curve,
}: DeriveSecretExtensionArgs) {
  if (isHardened) {
    // Hardened child
    const indexBuffer = Buffer.allocUnsafe(4);
    indexBuffer.writeUInt32BE(childIndex + BIP_32_HARDENED_OFFSET, 0);
    const pk = parentPrivateKey;
    const zb = Buffer.alloc(1, 0);
    return Buffer.concat([zb, pk, indexBuffer]);
  }

  // Normal child
  const indexBuffer = Buffer.allocUnsafe(4);
  indexBuffer.writeUInt32BE(childIndex, 0);
  const parentPublicKey = await curve.getPublicKey(parentPrivateKey, true);
  return Buffer.concat([parentPublicKey, indexBuffer]);
}

type GenerateKeyArgs = {
  parentPrivateKey: Buffer;
  parentExtraEntropy: string | Buffer;
  secretExtension: string | Buffer;
  curve: Curve;
};

/**
 * Add a tweak to the private key: `(privateKey + tweak) % n`.
 *
 * @param privateKeyBuffer - The private key as 32 byte Uint8Array.
 * @param tweakBuffer - The tweak as 32 byte Uint8Array.
 * @param curve - The curve to use.
 * @throws If the private key or tweak is invalid.
 * @returns The private key with the tweak added to it.
 */
export function privateAdd(
  privateKeyBuffer: Uint8Array,
  tweakBuffer: Uint8Array,
  curve: Curve,
): Uint8Array {
  const privateKey = bytesToNumber(privateKeyBuffer);
  const tweak = bytesToNumber(tweakBuffer);

  if (tweak >= curve.curve.n) {
    throw new Error('Invalid tweak: Tweak is larger than the curve order.');
  }

  const added = mod(privateKey + tweak, curve.curve.n);
  if (!curve.isValidPrivateKey(added)) {
    throw new Error(
      'Invalid private key or tweak: The resulting private key is invalid.',
    );
  }

  return hexStringToBuffer(added.toString(16).padStart(64, '0'));
}

/**
 * @param options
 * @param options.parentPrivateKey
 * @param options.parentExtraEntropy
 * @param options.secretExtension
 */
function generateKey({
  parentPrivateKey,
  parentExtraEntropy,
  secretExtension,
  curve,
}: GenerateKeyArgs) {
  const entropy = hmac(sha512, parentExtraEntropy, secretExtension);
  const keyMaterial = entropy.slice(0, 32);
  // extraEntropy is also called "chaincode"
  const extraEntropy = entropy.slice(32);

  // If curve is ed25519: The returned child key ki is parse256(IL).
  // https://github.com/satoshilabs/slips/blob/133ea52a8e43d338b98be208907e144277e44c0e/slip-0010.md#private-parent-key--private-child-key
  if (curve.name === 'ed25519') {
    return { privateKey: keyMaterial, extraEntropy };
  }

  const privateKey = privateAdd(parentPrivateKey, keyMaterial, curve);
  return { privateKey, extraEntropy };
}
