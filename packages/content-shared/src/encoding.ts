/**
 * Encode Uint8Array to base64 string.
 * Works in both Node.js and browser environments.
 */
export function encodeBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  // Browser environment
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return globalThis.btoa(binary);
}

/**
 * Decode base64 string to Uint8Array.
 * Works in both Node.js and browser environments.
 */
export function decodeBase64(base64: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(base64, "base64"));
  }
  // Browser environment
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Decode base64 to Float32Array with proper alignment.
 * Validates byte length is multiple of 4.
 */
export function decodeFloat32Array(base64: string): Float32Array {
  const bytes = decodeBase64(base64);
  if (bytes.length % 4 !== 0) {
    throw new Error(`Invalid Float32Array base64: length ${bytes.length} is not multiple of 4`);
  }
  const alignedBuffer = new ArrayBuffer(bytes.length);
  new Uint8Array(alignedBuffer).set(bytes);
  return new Float32Array(alignedBuffer);
}

/**
 * Encode Float32Array to base64 string.
 */
export function encodeFloat32Array(floats: Float32Array): string {
  return encodeBase64(new Uint8Array(floats.buffer));
}

/**
 * Pre-computed popcount table for fast Hamming distance.
 */
const POPCOUNT_TABLE = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  POPCOUNT_TABLE[i] = (i & 1) + (POPCOUNT_TABLE[i >> 1] ?? 0);
}

/**
 * Count set bits in a byte array (Hamming weight).
 */
export function popcount(bytes: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < bytes.length; i++) {
    count += POPCOUNT_TABLE[bytes[i]!] ?? 0;
  }
  return count;
}

/**
 * Calculate Hamming distance between two byte arrays.
 */
export function hammingDistance(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) {
    throw new Error(`Length mismatch: ${a.length} vs ${b.length}`);
  }
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    distance += POPCOUNT_TABLE[a[i]! ^ b[i]!] ?? 0;
  }
  return distance;
}
