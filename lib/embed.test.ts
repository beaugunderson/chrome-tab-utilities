import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// scripts/copy-ort.mjs stages exactly the ONNX runtime files the extension
// serves itself, because MV3 forbids remote script. Which files those are is a
// property of the transformers.js / onnxruntime-web build, verified against a
// real browser by scripts/verify-triage.mjs. These tests fail on a version
// bump so that check gets re-run rather than silently going stale into a 404
// at first inference.

const read = (path: string) => readFileSync(path, "utf8");

function version(pkg: string): string {
  return JSON.parse(read(`node_modules/${pkg}/package.json`)).version as string;
}

describe("ONNX runtime staging", () => {
  it("stages the file set verified against transformers.js 4.2.x", () => {
    expect(version("@huggingface/transformers")).toMatch(/^4\.2\./);
  });

  it("still ships the files copy-ort.mjs expects to find", () => {
    const script = read("scripts/copy-ort.mjs");
    for (const file of [
      "ort-wasm-simd-threaded.asyncify.wasm",
      "ort-wasm-simd-threaded.asyncify.mjs",
    ]) {
      expect(script).toContain(file);
    }
  });

  it("keeps wasmPaths pointed at the extension's own copy", () => {
    // A relative or CDN path would be blocked by the extension CSP.
    expect(read("lib/embed.ts")).toContain('chrome.runtime.getURL("ort/")');
  });

  it("keeps the CSP that allows WebAssembly on extension pages", () => {
    expect(read("wxt.config.ts")).toContain("wasm-unsafe-eval");
  });
});
