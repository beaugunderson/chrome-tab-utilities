#!/usr/bin/env node
// Stage the ONNX runtime into public/ort/ so the extension serves it itself.
//
// MV3 refuses remote script, so the runtime's loader (.mjs) cannot come from a
// CDN. The model weights are plain data and still download from Hugging Face
// on first use. onnxruntime-web is a transitive dependency, so resolve it
// through transformers rather than guessing a node_modules path.

import { createRequire } from "node:module";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// The asyncify variant, which is what the runtime requests once wasmPaths is
// set to a directory (verified by scripts/verify-triage.mjs, which asserts
// every fetched ort file is one of these). A missing file surfaces as a 404 at
// first inference rather than a build error, so the set is checked there.
const FILES = [
  "ort-wasm-simd-threaded.asyncify.wasm",
  "ort-wasm-simd-threaded.asyncify.mjs",
];

const require = createRequire(import.meta.url);
const transformers = require.resolve("@huggingface/transformers");
const fromTransformers = createRequire(transformers);
const ortDist = dirname(fromTransformers.resolve("onnxruntime-web"));

const target = join(process.cwd(), "public", "ort");
mkdirSync(target, { recursive: true });

for (const file of FILES) {
  copyFileSync(join(ortDist, file), join(target, file));
}

console.log(`copy-ort: staged ${FILES.length} files into public/ort/`);
