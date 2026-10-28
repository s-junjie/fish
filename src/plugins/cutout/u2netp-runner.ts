/**
 * U-2-Net Portable (u2netp) ONNX Background Removal Runner.
 *
 * Runs completely on the client side via onnxruntime-web (MIT) and u2netp (Apache-2.0).
 * Persists the 4.7MB model binary in IndexedDB so subsequent runs are instant and offline-ready.
 */

const U2NETP_MODEL_URL = "https://huggingface.co/facefusion/models-3.5.0/resolve/main/u2netp.onnx";
const ORT_CDN_URL = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/+esm";

const DB_NAME = "fish-plugin-cache";
const STORE_NAME = "model-weights";
const DB_VERSION = 1;

let ortModulePromise: Promise<any> | null = null;
let sessionPromise: Promise<any> | null = null;

function openCacheDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is not available in this environment"));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Failed to open IndexedDB"));
  });
}

async function getCachedModel(key: string): Promise<ArrayBuffer | null> {
  try {
    const db = await openCacheDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function setCachedModel(key: string, buffer: ArrayBuffer): Promise<void> {
  try {
    const db = await openCacheDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(buffer, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn("Failed to cache model to IndexedDB:", err);
  }
}

async function loadOrt() {
  if (!ortModulePromise) {
    ortModulePromise = import(/* @vite-ignore */ ORT_CDN_URL);
  }
  return ortModulePromise;
}

export type CutoutProgressCallback = (
  stage: "downloading" | "initializing" | "processing" | "done",
  detail?: string
) => void;

async function getSession(onProgress?: CutoutProgressCallback) {
  if (sessionPromise) return sessionPromise;

  sessionPromise = (async () => {
    onProgress?.("initializing", "Loading runtime...");
    const ort = await loadOrt();

    // Check IndexedDB cache first
    let modelBuffer = await getCachedModel("u2netp.onnx");
    if (!modelBuffer) {
      onProgress?.("downloading", "Downloading AI model (4.7MB)...");
      const res = await fetch(U2NETP_MODEL_URL);
      if (!res.ok) throw new Error(`Failed to download model: HTTP ${res.status}`);
      modelBuffer = await res.arrayBuffer();
      // Cache for subsequent cross-file usage
      await setCachedModel("u2netp.onnx", modelBuffer);
    }

    onProgress?.("initializing", "Initializing ONNX session...");
    // The shell is not cross-origin isolated, so ORT's pthread path can only
    // warn about SharedArrayBuffer and then fall back anyway — pin the pool to
    // one thread before the wasm backend is touched.
    ort.env.wasm.numThreads = 1;
    const session = await ort.InferenceSession.create(modelBuffer, {
      executionProviders: ["wasm"]
    });
    return { session, ort };
  })();

  return sessionPromise.catch((err) => {
    sessionPromise = null;
    throw err;
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load source image"));
    img.src = src;
  });
}

/**
 * Executes background removal on an image URI.
 * Returns the transparent PNG data URL and dimensions.
 */
export async function removeBackground(
  imageUri: string,
  onProgress?: CutoutProgressCallback
): Promise<{ uri: string; width: number; height: number }> {
  const img = await loadImage(imageUri);
  const origW = img.naturalWidth || img.width;
  const origH = img.naturalHeight || img.height;

  const { session, ort } = await getSession(onProgress);

  onProgress?.("processing", "Processing foreground mask...");

  // 1. Prepare 320x320 input tensor
  const targetSize = 320;
  const inCanvas = document.createElement("canvas");
  inCanvas.width = targetSize;
  inCanvas.height = targetSize;
  const inCtx = inCanvas.getContext("2d");
  if (!inCtx) throw new Error("Could not acquire 2D context");

  inCtx.drawImage(img, 0, 0, targetSize, targetSize);
  const { data } = inCtx.getImageData(0, 0, targetSize, targetSize);

  // Normalize image data to NCHW [1, 3, 320, 320] with ImageNet mean/std
  const floatData = new Float32Array(3 * targetSize * targetSize);
  const totalPixels = targetSize * targetSize;

  for (let i = 0; i < totalPixels; i++) {
    const r = data[i * 4] / 255;
    const g = data[i * 4 + 1] / 255;
    const b = data[i * 4 + 2] / 255;

    floatData[i] = (r - 0.485) / 0.229;
    floatData[totalPixels + i] = (g - 0.456) / 0.224;
    floatData[2 * totalPixels + i] = (b - 0.406) / 0.225;
  }

  const inputTensor = new ort.Tensor("float32", floatData, [1, 3, targetSize, targetSize]);
  const inputName = session.inputNames[0];

  // 2. Run inference
  const results = await session.run({ [inputName]: inputTensor });
  const outputName = session.outputNames[0];
  const outputTensor = results[outputName];
  const maskData = outputTensor.data as Float32Array;

  // 3. Find min/max for sigmoid / min-max normalization
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < maskData.length; i++) {
    const val = maskData[i];
    if (val < min) min = val;
    if (val > max) max = val;
  }
  const range = max - min || 1;

  // 4. Create 320x320 Alpha mask canvas
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = targetSize;
  maskCanvas.height = targetSize;
  const maskCtx = maskCanvas.getContext("2d");
  if (!maskCtx) throw new Error("Could not acquire mask context");

  const maskImageData = maskCtx.createImageData(targetSize, targetSize);
  for (let i = 0; i < totalPixels; i++) {
    // Normalize to 0~255
    const norm = (maskData[i] - min) / range;
    const alpha = Math.max(0, Math.min(255, Math.round(norm * 255)));
    maskImageData.data[i * 4] = 0;
    maskImageData.data[i * 4 + 1] = 0;
    maskImageData.data[i * 4 + 2] = 0;
    maskImageData.data[i * 4 + 3] = alpha;
  }
  maskCtx.putImageData(maskImageData, 0, 0);

  // 5. Composite mask onto original high-res image
  const outCanvas = document.createElement("canvas");
  outCanvas.width = origW;
  outCanvas.height = origH;
  const outCtx = outCanvas.getContext("2d");
  if (!outCtx) throw new Error("Could not acquire output context");

  // Step A: Draw resized smooth mask
  outCtx.imageSmoothingEnabled = true;
  outCtx.imageSmoothingQuality = "high";
  outCtx.drawImage(maskCanvas, 0, 0, origW, origH);

  // Step B: Source-in composite original image
  outCtx.globalCompositeOperation = "source-in";
  outCtx.drawImage(img, 0, 0, origW, origH);

  onProgress?.("done", "Complete");

  return {
    uri: outCanvas.toDataURL("image/png"),
    width: origW,
    height: origH
  };
}
