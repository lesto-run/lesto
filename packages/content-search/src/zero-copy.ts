/**
 * Zero-Copy Binary Index Format (Runtime)
 *
 * Memory-mapped binary format requiring zero parsing and zero copying.
 * BUILD-TIME functions (creation) are in @keel/content-embeddings.
 */

// ============================================================================
// Constants
// ============================================================================

const MAGIC = new Uint8Array([0x51, 0x53, 0x45, 0x41, 0x52, 0x43, 0x48, 0x00]);
const VERSION = 1;
const ENTRY_SIZE = 72;
const EMPTY_STRING_SENTINEL = 0xFFFFFFFF;

export enum IndexFlags {
  HAS_SIGNATURES = 1 << 0,
  HAS_BLOOM = 1 << 1,
  HAS_CLUSTERS = 1 << 2,
  UTF8_STRINGS = 1 << 3,
}

// ============================================================================
// Types
// ============================================================================

export interface ZeroCopyEntry {
  index: number;
  signature: Uint8Array;
  idOffset: number;
  titleOffset: number;
  slugOffset: number;
  snippetOffset: number;
  collectionOffset: number;
}

export interface DecodedEntry {
  id: string;
  title: string;
  slug: string;
  snippet: string;
  collection: string;
  signature: Uint8Array;
}

export interface ZeroCopySearchResult {
  index: number;
  distance: number;
  score: number;
}

// ============================================================================
// Header
// ============================================================================

interface Header {
  magic: Uint8Array;
  version: number;
  flags: number;
  entryCount: number;
  dimensions: number;
  signatureSize: number;
  entriesOffset: number;
  stringsOffset: number;
  bloomOffset: number;
}

// ============================================================================
// Zero-Copy Index Class
// ============================================================================

const POPCOUNT_TABLE = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let count = 0;
  let n = i;
  while (n) {
    count++;
    n &= n - 1;
  }
  POPCOUNT_TABLE[i] = count;
}

/**
 * Zero-copy binary index for ultra-fast search.
 */
export class ZeroCopyIndex {
  private buffer: ArrayBuffer;
  private view: DataView;
  private header: Header;
  private entriesView: Uint8Array;
  private stringsView: Uint8Array;

  constructor(buffer: ArrayBuffer) {
    this.buffer = buffer;
    this.view = new DataView(buffer);
    this.header = this.parseHeader();

    const entriesLength = this.header.entryCount * ENTRY_SIZE;
    this.entriesView = new Uint8Array(buffer, this.header.entriesOffset, entriesLength);

    const stringsLength = this.header.bloomOffset > 0
      ? this.header.bloomOffset - this.header.stringsOffset
      : buffer.byteLength - this.header.stringsOffset;
    this.stringsView = new Uint8Array(buffer, this.header.stringsOffset, stringsLength);
  }

  private parseHeader(): Header {
    const magic = new Uint8Array(this.buffer, 0, 8);
    for (let i = 0; i < 8; i++) {
      if (magic[i] !== MAGIC[i]) {
        throw new Error("Invalid index format: bad magic bytes");
      }
    }

    const version = this.view.getUint32(8, true);
    if (version !== VERSION) {
      throw new Error(`Unsupported index version: ${version}`);
    }

    return {
      magic,
      version,
      flags: this.view.getUint32(12, true),
      entryCount: this.view.getUint32(16, true),
      dimensions: this.view.getUint32(20, true),
      signatureSize: this.view.getUint32(24, true),
      entriesOffset: Number(this.view.getBigUint64(32, true)),
      stringsOffset: Number(this.view.getBigUint64(40, true)),
      bloomOffset: Number(this.view.getBigUint64(48, true)),
    };
  }

  get entryCount(): number {
    return this.header.entryCount;
  }

  get dimensions(): number {
    return this.header.dimensions;
  }

  getSignature(index: number): Uint8Array {
    this.validateIndex(index);
    const offset = this.header.entriesOffset + index * ENTRY_SIZE + 24;
    return new Uint8Array(this.buffer, offset, this.header.signatureSize);
  }

  getEntryOffsets(index: number): ZeroCopyEntry {
    this.validateIndex(index);
    const base = index * ENTRY_SIZE;

    return {
      index,
      idOffset: this.getEntryUint32(base, 0),
      titleOffset: this.getEntryUint32(base, 4),
      slugOffset: this.getEntryUint32(base, 8),
      snippetOffset: this.getEntryUint32(base, 12),
      collectionOffset: this.getEntryUint32(base, 16),
      signature: this.getSignature(index),
    };
  }

  getEntry(index: number): DecodedEntry {
    const offsets = this.getEntryOffsets(index);
    return {
      id: this.decodeString(offsets.idOffset),
      title: this.decodeString(offsets.titleOffset),
      slug: this.decodeString(offsets.slugOffset),
      snippet: this.decodeString(offsets.snippetOffset),
      collection: this.decodeString(offsets.collectionOffset),
      signature: offsets.signature,
    };
  }

  searchBinary(
    querySignature: Uint8Array,
    options: { limit?: number; maxDistance?: number } = {}
  ): ZeroCopySearchResult[] {
    const { limit = 10, maxDistance = Infinity } = options;
    const results: ZeroCopySearchResult[] = [];

    for (let i = 0; i < this.header.entryCount; i++) {
      const signature = this.getSignature(i);
      const distance = this.hammingDistance(querySignature, signature);

      if (distance <= maxDistance) {
        const totalBits = this.header.signatureSize * 8;
        results.push({
          index: i,
          distance,
          score: totalBits > 0 ? 1 - distance / totalBits : 0,
        });
      }
    }

    results.sort((a, b) => a.distance - b.distance);
    return results.slice(0, limit);
  }

  private hammingDistance(a: Uint8Array, b: Uint8Array): number {
    let distance = 0;
    for (let i = 0; i < a.length; i++) {
      const aVal = a[i];
      const bVal = b[i];
      if (aVal !== undefined && bVal !== undefined) {
        distance += POPCOUNT_TABLE[aVal ^ bVal]!;
      }
    }
    return distance;
  }

  private validateIndex(index: number): void {
    if (index < 0 || index >= this.header.entryCount) {
      throw new RangeError(`Entry index out of bounds: ${index}`);
    }
  }

  private getEntryUint32(entryBase: number, offset: number): number {
    const idx = entryBase + offset;
    const val0 = this.entriesView[idx];
    const val1 = this.entriesView[idx + 1];
    const val2 = this.entriesView[idx + 2];
    const val3 = this.entriesView[idx + 3];
    if (val0 === undefined || val1 === undefined || val2 === undefined || val3 === undefined) {
      return 0;
    }
    return val0 | (val1 << 8) | (val2 << 16) | (val3 << 24);
  }

  private decodeString(offset: number): string {
    if (offset === EMPTY_STRING_SENTINEL) return "";

    // Bounds check: offset must be within stringsView
    if (offset < 0 || offset >= this.stringsView.length) {
      throw new RangeError(`Invalid string offset: ${offset} (max: ${this.stringsView.length - 1})`);
    }

    let end = offset;
    while (end < this.stringsView.length && this.stringsView[end] !== 0) {
      end++;
    }

    // Detect malformed data: missing null terminator
    if (end === this.stringsView.length && this.stringsView[end - 1] !== 0) {
      throw new Error(`Malformed index: string at offset ${offset} missing null terminator`);
    }

    // Use subarray for true zero-copy - creates a view, not a copy
    const bytes = this.stringsView.subarray(offset, end);
    return new TextDecoder().decode(bytes);
  }
}

/**
 * Load a zero-copy index from URL.
 */
export async function loadZeroCopyIndex(url: string): Promise<ZeroCopyIndex> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load zero-copy index: ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  return new ZeroCopyIndex(buffer);
}
