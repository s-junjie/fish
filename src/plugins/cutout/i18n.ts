export interface CutoutStrings {
  previewAlt: string;
  actionButton: string;
  revertButton: string;
  processing: string;
  applied: string;
  noSelectionTitle: string;
  noSelectionDesc: string;
  statusPreparing: string;
  statusDownloading: string;
  statusInitializing: string;
  statusProcessing: string;
  statusDone: string;
  successHint: string;
  revertHint: string;
  failed: string;
  engineName: string;
  engineLicense: string;
}

export const cutoutStrings: CutoutStrings = {
  previewAlt: "Preview",
  actionButton: "Remove Background",
  revertButton: "Restore Original Image",
  processing: "Removing background...",
  applied: "Applied",
  noSelectionTitle: "No Image Selected",
  noSelectionDesc: "Select an element with an image fill on the canvas to remove its background.",
  statusPreparing: "Preparing...",
  statusDownloading: "Downloading AI model (4.7MB)...",
  statusInitializing: "Initializing ONNX session...",
  statusProcessing: "Segmenting foreground...",
  statusDone: "Complete!",
  successHint: "Background removed successfully",
  revertHint: "Restored to original image",
  failed: "Background removal failed",
  engineName: "U-2-Net Portable",
  engineLicense: "Apache-2.0"
};
