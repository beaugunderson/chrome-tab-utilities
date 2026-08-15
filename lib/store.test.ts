import { describe, expect, it } from "vitest";
import { dequantize, quantize } from "./store";

function unit(values: number[]): Float32Array {
  const vec = Float32Array.from(values);
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

describe("quantize / dequantize", () => {
  it("round-trips a unit vector within int8 precision", () => {
    const original = unit([0.4, -0.7, 0.2, 0.55, -0.1, 0.9]);
    const restored = dequantize(quantize(original));
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i], 2);
    }
  });

  it("returns a unit-length vector, so cosine stays a dot product", () => {
    const restored = dequantize(quantize(unit([0.4, -0.7, 0.2, 0.55])));
    expect(dot(restored, restored)).toBeCloseTo(1, 5);
  });

  it("preserves similarity ordering between vectors", () => {
    const query = unit([1, 0, 0, 0]);
    const near = unit([0.95, 0.1, 0.05, 0]);
    const far = unit([0, 1, 0, 0]);

    const q = dequantize(quantize(query));
    expect(dot(q, dequantize(quantize(near)))).toBeGreaterThan(
      dot(q, dequantize(quantize(far))),
    );
  });

  it("handles negative components, which two's complement bytes must survive", () => {
    const original = unit([-0.9, -0.3, 0.1, 0.2]);
    const restored = dequantize(quantize(original));
    expect(restored[0]).toBeLessThan(0);
    expect(restored[1]).toBeLessThan(0);
    expect(restored[2]).toBeGreaterThan(0);
  });

  it("keeps a 384-dim vector under 600 bytes encoded", () => {
    const vec = unit(Array.from({ length: 384 }, (_, i) => Math.sin(i)));
    expect(quantize(vec).length).toBeLessThan(600);
  });

  it("does not distort a near-duplicate pair below the 0.95 threshold", () => {
    // Two vectors 5 degrees apart stay above the duplicate cutoff after
    // quantization, which is what the dupe detector depends on.
    const a = unit([Math.cos(0), Math.sin(0)]);
    const b = unit([Math.cos(0.087), Math.sin(0.087)]);
    expect(dot(dequantize(quantize(a)), dequantize(quantize(b)))).toBeGreaterThan(0.95);
  });
});
