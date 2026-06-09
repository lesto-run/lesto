import { describe, it, expect } from "vitest";
import {
  encodeBase64,
  decodeBase64,
  decodeFloat32Array,
  encodeFloat32Array,
  popcount,
  hammingDistance,
} from "../encoding.js";

describe("encodeBase64", () => {
  it("encodes empty array", () => {
    const bytes = new Uint8Array([]);
    expect(encodeBase64(bytes)).toBe("");
  });

  it("encodes simple bytes", () => {
    const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    expect(encodeBase64(bytes)).toBe("SGVsbG8=");
  });

  it("encodes binary data", () => {
    const bytes = new Uint8Array([0, 127, 255, 128, 64]);
    const encoded = encodeBase64(bytes);
    expect(typeof encoded).toBe("string");
    // Should be valid base64
    expect(encoded).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
  });

  it("encodes all byte values", () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      bytes[i] = i;
    }
    const encoded = encodeBase64(bytes);
    expect(typeof encoded).toBe("string");
    expect(encoded.length).toBeGreaterThan(0);
  });
});

describe("decodeBase64", () => {
  it("decodes empty string", () => {
    const bytes = decodeBase64("");
    expect(bytes).toEqual(new Uint8Array([]));
  });

  it("decodes simple base64", () => {
    const bytes = decodeBase64("SGVsbG8=");
    expect(bytes).toEqual(new Uint8Array([72, 101, 108, 108, 111])); // "Hello"
  });

  it("roundtrips with encodeBase64", () => {
    const original = new Uint8Array([1, 2, 3, 255, 128, 0]);
    const encoded = encodeBase64(original);
    const decoded = decodeBase64(encoded);
    expect(decoded).toEqual(original);
  });

  it("handles padding correctly", () => {
    // 1 byte = 2 base64 chars + 2 padding
    const oneByteEncoded = encodeBase64(new Uint8Array([65]));
    expect(oneByteEncoded).toBe("QQ==");
    expect(decodeBase64(oneByteEncoded)).toEqual(new Uint8Array([65]));

    // 2 bytes = 3 base64 chars + 1 padding
    const twoBytesEncoded = encodeBase64(new Uint8Array([65, 66]));
    expect(twoBytesEncoded).toBe("QUI=");
    expect(decodeBase64(twoBytesEncoded)).toEqual(new Uint8Array([65, 66]));

    // 3 bytes = 4 base64 chars + 0 padding
    const threeBytesEncoded = encodeBase64(new Uint8Array([65, 66, 67]));
    expect(threeBytesEncoded).toBe("QUJD");
    expect(decodeBase64(threeBytesEncoded)).toEqual(new Uint8Array([65, 66, 67]));
  });
});

describe("decodeFloat32Array", () => {
  it("decodes valid Float32Array data", () => {
    // Create known Float32Array
    const floats = new Float32Array([1.0, 2.0, 3.0]);
    const bytes = new Uint8Array(floats.buffer);
    const encoded = encodeBase64(bytes);

    const decoded = decodeFloat32Array(encoded);
    expect(decoded.length).toBe(3);
    expect(decoded[0]).toBeCloseTo(1.0);
    expect(decoded[1]).toBeCloseTo(2.0);
    expect(decoded[2]).toBeCloseTo(3.0);
  });

  it("throws on invalid length (not multiple of 4)", () => {
    // 3 bytes is not a valid Float32Array
    const invalidBytes = new Uint8Array([1, 2, 3]);
    const encoded = encodeBase64(invalidBytes);

    expect(() => decodeFloat32Array(encoded)).toThrow(
      /length 3 is not multiple of 4/
    );
  });

  it("handles empty array", () => {
    const decoded = decodeFloat32Array("");
    expect(decoded).toEqual(new Float32Array([]));
  });

  it("handles special float values", () => {
    const floats = new Float32Array([0, -0, Infinity, -Infinity, NaN]);
    const bytes = new Uint8Array(floats.buffer);
    const encoded = encodeBase64(bytes);

    const decoded = decodeFloat32Array(encoded);
    expect(decoded[0]).toBe(0);
    expect(Object.is(decoded[1], -0)).toBe(true);
    expect(decoded[2]).toBe(Infinity);
    expect(decoded[3]).toBe(-Infinity);
    expect(Number.isNaN(decoded[4])).toBe(true);
  });
});

describe("encodeFloat32Array", () => {
  it("encodes Float32Array to base64", () => {
    const floats = new Float32Array([1.5, 2.5, 3.5]);
    const encoded = encodeFloat32Array(floats);

    expect(typeof encoded).toBe("string");
    expect(encoded.length).toBeGreaterThan(0);
  });

  it("roundtrips with decodeFloat32Array", () => {
    const original = new Float32Array([0.1, 0.2, 0.3, 100.0, -50.5]);
    const encoded = encodeFloat32Array(original);
    const decoded = decodeFloat32Array(encoded);

    expect(decoded.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(decoded[i]).toBeCloseTo(original[i]!, 5);
    }
  });

  it("handles empty array", () => {
    const floats = new Float32Array([]);
    const encoded = encodeFloat32Array(floats);
    expect(encoded).toBe("");
  });
});

describe("popcount", () => {
  it("counts zero bits", () => {
    expect(popcount(new Uint8Array([0]))).toBe(0);
    expect(popcount(new Uint8Array([0, 0, 0]))).toBe(0);
  });

  it("counts all bits set", () => {
    expect(popcount(new Uint8Array([255]))).toBe(8);
    expect(popcount(new Uint8Array([255, 255]))).toBe(16);
  });

  it("counts single bit", () => {
    expect(popcount(new Uint8Array([1]))).toBe(1);
    expect(popcount(new Uint8Array([2]))).toBe(1);
    expect(popcount(new Uint8Array([4]))).toBe(1);
    expect(popcount(new Uint8Array([128]))).toBe(1);
  });

  it("counts multiple bytes", () => {
    // 0b01010101 = 4 bits, 0b10101010 = 4 bits
    expect(popcount(new Uint8Array([0b01010101, 0b10101010]))).toBe(8);
  });

  it("handles empty array", () => {
    expect(popcount(new Uint8Array([]))).toBe(0);
  });

  it("counts known patterns", () => {
    expect(popcount(new Uint8Array([0b00001111]))).toBe(4);
    expect(popcount(new Uint8Array([0b11110000]))).toBe(4);
    expect(popcount(new Uint8Array([0b11111111]))).toBe(8);
  });
});

describe("hammingDistance", () => {
  it("returns 0 for identical arrays", () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3]);
    expect(hammingDistance(a, b)).toBe(0);
  });

  it("counts differing bits", () => {
    // 0 vs 1 = 1 bit different
    expect(hammingDistance(new Uint8Array([0]), new Uint8Array([1]))).toBe(1);

    // 0 vs 3 = 2 bits different (0b00 vs 0b11)
    expect(hammingDistance(new Uint8Array([0]), new Uint8Array([3]))).toBe(2);

    // 0 vs 255 = 8 bits different
    expect(hammingDistance(new Uint8Array([0]), new Uint8Array([255]))).toBe(8);
  });

  it("throws on length mismatch", () => {
    const a = new Uint8Array([1, 2]);
    const b = new Uint8Array([1, 2, 3]);

    expect(() => hammingDistance(a, b)).toThrow(/Length mismatch: 2 vs 3/);
  });

  it("handles multiple bytes", () => {
    const a = new Uint8Array([0, 0]);
    const b = new Uint8Array([255, 255]);
    expect(hammingDistance(a, b)).toBe(16);
  });

  it("handles empty arrays", () => {
    expect(hammingDistance(new Uint8Array([]), new Uint8Array([]))).toBe(0);
  });

  it("is symmetric", () => {
    const a = new Uint8Array([0b10101010]);
    const b = new Uint8Array([0b01010101]);
    expect(hammingDistance(a, b)).toBe(hammingDistance(b, a));
  });
});
