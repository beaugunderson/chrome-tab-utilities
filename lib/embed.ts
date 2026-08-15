// Sentence embeddings via transformers.js, running in the triage page.
//
// Not the service worker (killed at 30s idle) and not the offscreen document:
// Chrome allows exactly one offscreen document, and the clipboard helpers in
// background.ts close it after every copy, which would unload the model.

import { env, pipeline } from "@huggingface/transformers";
import type { FeatureExtractionPipeline } from "@huggingface/transformers";

const MODEL = "Xenova/all-MiniLM-L6-v2";
const BATCH_SIZE = 32;
export const EMBEDDING_DIMS = 384;

// MV3 forbids remote script, so the ONNX runtime's loader and wasm binary are
// served from the extension. Model *weights* are plain data and still come
// from the Hugging Face CDN on first use, cached by the browser thereafter.
const wasmEnv = env.backends.onnx.wasm!;
wasmEnv.wasmPaths = chrome.runtime.getURL("ort/");
// Extension pages are not cross-origin isolated, so SharedArrayBuffer is
// unavailable and the runtime is single-threaded regardless. Saying so keeps
// it from spawning workers that cannot help.
wasmEnv.numThreads = 1;
// Skips the blob-URL path for the wasm factory, which the extension CSP blocks.
env.useWasmCache = false;

let pipe: Promise<FeatureExtractionPipeline> | null = null;

export interface LoadProgress {
  status: string;
  file?: string;
  progress?: number;
}

export function loadEmbedder(
  onProgress?: (p: LoadProgress) => void,
): Promise<FeatureExtractionPipeline> {
  if (!pipe) {
    pipe = pipeline("feature-extraction", MODEL, {
      dtype: "q8",
      device: "wasm",
      progress_callback: onProgress as never,
    });
  }
  return pipe;
}

/**
 * Embed texts in order, returning unit-length vectors so cosine similarity is
 * a plain dot product. Reports progress per batch, since a cold run over a few
 * hundred tabs takes seconds.
 */
export async function embedAll(
  texts: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const extractor = await loadEmbedder();
  const out: Float32Array[] = [];

  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    const batch = texts.slice(start, start + BATCH_SIZE);
    const tensor = await extractor(batch, {
      pooling: "mean",
      normalize: true,
    });
    const flat = tensor.data as Float32Array;
    const dims = tensor.dims[tensor.dims.length - 1];
    for (let i = 0; i < batch.length; i++) {
      out.push(flat.slice(i * dims, (i + 1) * dims) as Float32Array);
    }
    onProgress?.(Math.min(start + BATCH_SIZE, texts.length), texts.length);
  }

  return out;
}
