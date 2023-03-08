import { assert } from '@metamask/utils';
import { keccak_256 as keccak256 } from '@noble/hashes/sha3';

import { DeriveChildKeyArgs } from '.';
import { BIP_32_HARDENED_OFFSET, BYTES_KEY_LENGTH } from '../constants';
import { Curve, secp256k1 } from '../curves';
import { SLIP10Node } from '../SLIP10Node';
import { isValidBytesKey, validateBIP32Index } from '../utils';
import {
  derivePrivateChildKey,
  derivePublicChildKey,
  derivePublicExtension,
  deriveSecretExtension,
  generateEntropy,
} from './shared';

/**
 * Converts a BIP-32 private key to an Ethereum address.
 *
 * **WARNING:** Only validates that the key is non-zero and of the correct
 * length. It is the consumer's responsibility to ensure that the specified
 * key is a valid BIP-44 Ethereum `address_index` key.
 *
 * @param key - The `address_index` private key bytes to convert to an Ethereum
 * address.
 * @returns The Ethereum address corresponding to the given key.
 */
export function privateKeyToEthAddress(key: Uint8Array) {
  assert(
    key instanceof Uint8Array && isValidBytesKey(key, BYTES_KEY_LENGTH),
    'Invalid key: The key must be a 32-byte, non-zero Uint8Array.',
  );

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
 * @param key - The `address_index` public key bytes to convert to an Ethereum
 * address.
 * @returns The Ethereum address corresponding to the given key.
 */
export function publicKeyToEthAddress(key: Uint8Array) {
  assert(
    key instanceof Uint8Array &&
      isValidBytesKey(key, secp256k1.publicKeyLength),
    'Invalid key: The key must be a 65-byte, non-zero Uint8Array.',
  );

  return keccak256(key.slice(1)).slice(-20);
}

/**
 * Derive a BIP-32 child key with a given path from a parent key.
 *
 * @param options - The options for deriving a child key.
 * @param options.path - The derivation path part to derive.
 * @param options.node - The node to derive from.
 * @param options.curve - The curve to use for derivation.
 * @returns The derived child key as a {@link SLIP10Node}.
 */
export async function deriveChildKey({
  path,
  node,
  curve,
}: DeriveChildKeyArgs): Promise<SLIP10Node> {
  // TODO: Shared validation.
  assert(typeof path === 'string', 'Invalid path: Must be a string.');
  assert(
    curve.name === 'secp256k1',
    'Invalid curve: Only secp256k1 is supported by BIP-32.',
  );

  if (!node) {
    throw new Error('Invalid parameters: Must specify a node to derive from.');
  }

  const isHardened = path.includes(`'`);
  if (isHardened && !node.privateKey) {
    throw new Error(
      'Invalid parameters: Cannot derive hardened child keys without a private key.',
    );
  }

  const indexPart = path.split(`'`)[0];
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

  const args = {
    chainCode: node.chainCodeBytes,
    childIndex,
    isHardened,
    depth: node.depth,
    parentFingerprint: node.fingerprint,
    masterFingerprint: node.masterFingerprint,
    curve,
  };

  if (node.privateKeyBytes) {
    const secretExtension = await deriveSecretExtension({
      privateKey: node.privateKeyBytes,
      childIndex,
      isHardened,
      curve,
    });

    const entropy = generateEntropy({
      chainCode: node.chainCodeBytes,
      extension: secretExtension,
    });

    return deriveNode({
      privateKey: node.privateKeyBytes,
      entropy,
      ...args,
    });
  }

  const publicExtension = derivePublicExtension({
    parentPublicKey: node.compressedPublicKeyBytes,
    childIndex,
  });

  const entropy = generateEntropy({
    chainCode: node.chainCodeBytes,
    extension: publicExtension,
  });

  return deriveNode({
    publicKey: node.compressedPublicKeyBytes,
    entropy,
    ...args,
  });
}

type BaseDeriveKeyArgs = {
  entropy: Uint8Array;
  chainCode: Uint8Array;
  childIndex: number;
  isHardened: boolean;
  depth: number;
  parentFingerprint: number;
  masterFingerprint?: number;
  curve: Curve;
};

type DerivePrivateKeyArgs = BaseDeriveKeyArgs & {
  privateKey: Uint8Array;
  publicKey?: never;
};

type DerivePublicKeyArgs = BaseDeriveKeyArgs & {
  publicKey: Uint8Array;
  privateKey?: never;
};

type DeriveKeyArgs = DerivePrivateKeyArgs | DerivePublicKeyArgs;

/**
 * Derive a BIP-32 child key from a parent key.
 *
 * @param options - The options for deriving a child key.
 * @param options.privateKey - The private key to derive from.
 * @param options.publicKey - The public key to derive from.
 * @param options.entropy - The entropy to use for deriving the child key.
 * @param options.chainCode - The chain code to use for deriving the child key.
 * @param options.childIndex - The child index to use for deriving the child key.
 * @param options.isHardened - Whether the child key is hardened.
 * @param options.depth - The depth of the child key.
 * @param options.parentFingerprint - The fingerprint of the parent key.
 * @param options.masterFingerprint - The fingerprint of the master key.
 * @param options.curve - The curve to use for deriving the child key.
 * @returns The derived child key as {@link SLIP10Node}.
 */
async function deriveNode({
  privateKey,
  publicKey,
  entropy,
  chainCode,
  childIndex,
  isHardened,
  depth,
  parentFingerprint,
  masterFingerprint,
  curve,
}: DeriveKeyArgs): Promise<SLIP10Node> {
  try {
    if (privateKey) {
      return await derivePrivateChildKey({
        entropy,
        privateKey,
        depth,
        masterFingerprint,
        parentFingerprint,
        childIndex,
        isHardened,
        curve,
      });
    }

    return await derivePublicChildKey({
      entropy,
      publicKey,
      depth,
      masterFingerprint,
      parentFingerprint,
      childIndex,
      curve,
    });
  } catch {
    validateBIP32Index(childIndex + 1);

    const args = {
      entropy,
      chainCode,
      childIndex: childIndex + 1,
      isHardened,
      depth,
      parentFingerprint,
      masterFingerprint,
      curve,
    };

    if (privateKey) {
      const secretExtension = await deriveSecretExtension({
        privateKey,
        childIndex: childIndex + 1,
        isHardened,
        curve,
      });

      const newEntropy = generateEntropy({
        chainCode,
        extension: secretExtension,
      });

      return deriveNode({
        ...args,
        privateKey,
        entropy: newEntropy,
      });
    }

    const publicExtension = derivePublicExtension({
      parentPublicKey: publicKey,
      childIndex: childIndex + 1,
    });

    const newEntropy = generateEntropy({
      chainCode,
      extension: publicExtension,
    });

    return deriveNode({
      ...args,
      publicKey,
      entropy: newEntropy,
    });
  }
}
