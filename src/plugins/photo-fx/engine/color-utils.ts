export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export function parseHex(hex: string): RgbColor {
  let clean = hex.replace("#", "").trim();
  if (clean.length === 3) {
    clean = clean.split("").map((c) => c + c).join("");
  }
  const num = parseInt(clean, 16);
  if (isNaN(num)) return { r: 0, g: 0, b: 0 };
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255
  };
}

export function rgbToHex(c: RgbColor): string {
  const toH = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${toH(c.r)}${toH(c.g)}${toH(c.b)}`;
}

export function lerpRgb(c1: RgbColor, c2: RgbColor, t: number): RgbColor {
  const clampT = Math.max(0, Math.min(1, t));
  return {
    r: c1.r + (c2.r - c1.r) * clampT,
    g: c1.g + (c2.g - c1.g) * clampT,
    b: c1.b + (c2.b - c1.b) * clampT
  };
}

/** Rec. 709 luminance in [0, 1] */
export function getLuminance(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Adjust contrast around mid-tone 0.5 */
export function applyContrast(lum: number, contrast: number, invert: boolean): number {
  let val = invert ? 1 - lum : lum;
  if (contrast !== 1.0) {
    val = (val - 0.5) * contrast + 0.5;
  }
  return Math.max(0, Math.min(1, val));
}

/** Map pixel luminance to duotone gradient */
export function applyDuotoneToImageData(
  imgData: ImageData,
  darkColorHex: string,
  lightColorHex: string
): ImageData {
  const darkRgb = parseHex(darkColorHex);
  const lightRgb = parseHex(lightColorHex);
  const { data } = imgData;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 0) continue;
    const lum = getLuminance(data[i], data[i + 1], data[i + 2]);
    const mapped = lerpRgb(darkRgb, lightRgb, lum);
    data[i] = Math.round(mapped.r);
    data[i + 1] = Math.round(mapped.g);
    data[i + 2] = Math.round(mapped.b);
  }
  return imgData;
}
