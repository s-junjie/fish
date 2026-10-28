export interface RetroPrintStrings {
  title: string;
  selectImageHint: string;
  preview: string;
  mode: string;
  modeDots: string;
  modeLines: string;
  modeBars: string;
  modeCrosshatch: string;
  modeDither: string;
  ditherType: string;
  ditherBayer4: string;
  ditherBayer8: string;
  ditherFloyd: string;
  ditherAtkinson: string;
  dotSize: string;
  stripeSpacing: string;
  barLevel: string;
  barFalloff: string;
  angle: string;
  contrast: string;
  invert: string;
  colorMode: string;
  duotone: string;
  originalColor: string;
  darkColor: string;
  lightColor: string;
  transparentBg: string;
  presets: string;
  presetViolet: string;
  presetMono: string;
  presetCyber: string;
  presetRiso: string;
  presetEmerald: string;
  applyMode: string;
  asNewLayer: string;
  replaceCurrent: string;
  applyBtn: string;
  processing: string;
  successHint: string;
  transition: string;
  transitionMode: string;
  transNone: string;
  transHorizontal: string;
  transVertical: string;
  transTwoEnds: string;
  transRadial: string;
  transitionBlend: string;
  blendOverlay: string;
  blendReveal: string;
  blendFade: string;
  transSpread: string;
  transInvert: string;
}

const en: RetroPrintStrings = {
  title: "Retro Print & Halftone",
  selectImageHint: "Select an image on canvas to begin",
  preview: "Preview",
  mode: "Pattern Style",
  modeDots: "Halftone Dots",
  modeLines: "Stripes (Lines)",
  modeBars: "Bar Screen (Hard Edge)",
  modeCrosshatch: "Crosshatch",
  modeDither: "Pixel Dither",
  ditherType: "Algorithm",
  ditherBayer4: "Bayer 4×4",
  ditherBayer8: "Bayer 8×8",
  ditherFloyd: "Floyd-Steinberg",
  ditherAtkinson: "Atkinson",
  dotSize: "Grid Size",
  stripeSpacing: "Stripe Spacing",
  barLevel: "Ink Level",
  barFalloff: "Width Falloff",
  angle: "Angle",
  contrast: "Contrast",
  invert: "Invert",
  colorMode: "Color",
  duotone: "Duotone",
  originalColor: "Original",
  darkColor: "Ink",
  lightColor: "Paper",
  transparentBg: "Transparent",
  presets: "Palettes",
  presetViolet: "Editorial Violet",
  presetMono: "Classic Mono",
  presetCyber: "Cyber Neon",
  presetRiso: "Risograph Warm",
  presetEmerald: "Vintage Emerald",
  applyMode: "Destination",
  asNewLayer: "New Layer",
  replaceCurrent: "Replace Fill",
  applyBtn: "Apply to Canvas",
  processing: "Processing…",
  successHint: "Applied retro print effect to canvas",
  transition: "Transition",
  transitionMode: "Transition Direction",
  transNone: "None (Full)",
  transHorizontal: "Horizontal (Left to Right)",
  transVertical: "Vertical (Top to Bottom)",
  transTwoEnds: "Top & Bottom (Two Ends)",
  transRadial: "Radial",
  transitionBlend: "Blend Style",
  blendOverlay: "Overlay on Photo",
  blendReveal: "Photo to Pattern",
  blendFade: "Pattern Only",
  transSpread: "Fade Range",
  transInvert: "Invert Direction"
};

const zh: RetroPrintStrings = {
  title: "复古印艺与半色调",
  selectImageHint: "在画布上选择图片以开始",
  preview: "效果预览",
  mode: "网纹风格",
  modeDots: "半色调圆点 (Dots)",
  modeLines: "艺术条纹 (Stripes)",
  modeBars: "硬边竖条 (Bar Screen)",
  modeCrosshatch: "双向交叉线 (Cross)",
  modeDither: "颗粒抖动 (Dither)",
  ditherType: "抖动算法",
  ditherBayer4: "Bayer 4×4 网格",
  ditherBayer8: "Bayer 8×8 网格",
  ditherFloyd: "Floyd-Steinberg 扩散",
  ditherAtkinson: "Atkinson 经典点阵",
  dotSize: "网格大小",
  stripeSpacing: "条纹间距",
  barLevel: "墨量",
  barFalloff: "宽度衰减",
  angle: "旋转角度",
  contrast: "对比度",
  invert: "反转明暗",
  colorMode: "色彩模式",
  duotone: "双色调 (Duotone)",
  originalColor: "保留原色彩",
  darkColor: "油墨色",
  lightColor: "纸张色",
  transparentBg: "透明底",
  presets: "色板预设",
  presetViolet: "时尚深紫 (Editorial)",
  presetMono: "经典黑白 (Mono)",
  presetCyber: "赛博霓虹 (Cyber)",
  presetRiso: "孔版暖调 (Risograph)",
  presetEmerald: "复古墨绿 (Emerald)",
  applyMode: "应用方式",
  asNewLayer: "生成新图层",
  replaceCurrent: "替换当前填充",
  applyBtn: "应用到画布",
  processing: "处理中…",
  successHint: "已成功应用复古印艺效果到画布",
  transition: "渐变与过渡",
  transitionMode: "过渡方向",
  transNone: "无 (全图)",
  transHorizontal: "水平渐变 (左到右)",
  transVertical: "垂直渐变 (上到下)",
  transTwoEnds: "上下两端渐隐 (Top & Bottom)",
  transRadial: "径向向外 (Radial)",
  transitionBlend: "合成方式",
  blendOverlay: "叠印在原图上 (Overlay)",
  blendReveal: "原图渐变到图案 (Reveal)",
  blendFade: "仅图案渐隐 (Pattern Only)",
  transSpread: "渐隐范围",
  transInvert: "反转方向"
};

export function getStrings(locale: string = "en"): RetroPrintStrings {
  return locale.startsWith("zh") ? zh : en;
}
