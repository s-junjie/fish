import {
  CornerRadius,
  DropShadowEffect,
  EdgeInsets,
  EdgeSide,
  Effect,
  InnerShadowEffect,
  LayerBlurEffect,
  BackdropBlurEffect,
  LiquidGlassEffect,
  TearEffect,
  TearForm,
  TornFields
} from "../dsl/types";
import { hexToRgb, parseColorAlpha } from "../geometry/color-utils";

const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
const round2 = (n: number): number => Math.round(n * 100) / 100;

function lerpColor(c1: string, c2: string, p: number): string {
  const p1 = parseColorAlpha(c1);
  const p2 = parseColorAlpha(c2);
  const rgb1 = hexToRgb(p1.hex6);
  const rgb2 = hexToRgb(p2.hex6);
  const r = Math.round(lerp(rgb1.r, rgb2.r, p));
  const g = Math.round(lerp(rgb1.g, rgb2.g, p));
  const b = Math.round(lerp(rgb1.b, rgb2.b, p));
  const a = round2(lerp(p1.alphaPct / 100, p2.alphaPct / 100, p));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function transparentColor(c: string): string {
  const { hex6 } = parseColorAlpha(c);
  const rgb = hexToRgb(hex6);
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0)`;
}

export function interpolateCornerRadius(
  from: CornerRadius | undefined,
  to: CornerRadius | undefined,
  p: number
): CornerRadius | undefined {
  if (from === undefined && to === undefined) return undefined;
  const toQuad = (cr: CornerRadius | undefined): [number, number, number, number] => {
    if (cr === undefined) return [0, 0, 0, 0];
    if (typeof cr === "number") return [cr, cr, cr, cr];
    return [cr[0] ?? 0, cr[1] ?? 0, cr[2] ?? 0, cr[3] ?? 0];
  };
  const q1 = toQuad(from);
  const q2 = toQuad(to);
  const res: [number, number, number, number] = [
    round2(lerp(q1[0], q2[0], p)),
    round2(lerp(q1[1], q2[1], p)),
    round2(lerp(q1[2], q2[2], p)),
    round2(lerp(q1[3], q2[3], p))
  ];
  if (res[0] === res[1] && res[1] === res[2] && res[2] === res[3]) {
    return res[0];
  }
  return res;
}

function interpolateLayerBlur(
  from: LayerBlurEffect | undefined,
  to: LayerBlurEffect | undefined,
  p: number
): LayerBlurEffect {
  const fromBlur = from?.blur ?? 0;
  const toBlur = to?.blur ?? 0;
  const enabled = p < 0.5 ? from?.enabled : to?.enabled;
  return {
    type: "layer-blur",
    blur: round2(lerp(fromBlur, toBlur, p)),
    ...(enabled !== undefined ? { enabled } : null)
  };
}

function interpolateBackdropBlur(
  from: BackdropBlurEffect | undefined,
  to: BackdropBlurEffect | undefined,
  p: number
): BackdropBlurEffect {
  const fromBlur = from?.blur ?? 0;
  const toBlur = to?.blur ?? 0;
  const enabled = p < 0.5 ? from?.enabled : to?.enabled;
  return {
    type: "backdrop-blur",
    blur: round2(lerp(fromBlur, toBlur, p)),
    ...(enabled !== undefined ? { enabled } : null)
  };
}

function defaultAtForSide(side: EdgeSide | undefined): number {
  return side === "right" || side === "bottom" ? 1 : 0;
}

function resolveAt(at: number | [number, number] | undefined, side: EdgeSide | undefined): [number, number] {
  if (at === undefined) {
    const d = defaultAtForSide(side);
    return [d, d];
  }
  if (typeof at === "number") return [at, at];
  return [at[0], at[1]];
}

function defaultInsetForForm(form: TearForm | undefined): number {
  if (form === "hole") return 100;
  return 0;
}

function resolveInset(inset: number | EdgeInsets | undefined, form: TearForm | undefined): EdgeInsets {
  if (inset === undefined) {
    const d = defaultInsetForForm(form);
    return [d, d, d, d];
  }
  if (typeof inset === "number") return [inset, inset, inset, inset];
  return [inset[0], inset[1], inset[2], inset[3]];
}

function neutralTearFor(other: TearEffect): TearEffect {
  const form = other.form ?? "edge";
  const side = other.side ?? "right";
  const profile = other.profile ?? "torn";
  const isTorn = profile === "torn";
  if (form === "hole") {
    const d = defaultInsetForForm("hole");
    return {
      type: "tear",
      form: "hole",
      profile,
      scale: 0,
      seed: other.seed,
      inset: Array.isArray(other.inset) ? [d, d, d, d] : d,
      ...(isTorn ? { roughness: 0, fiber: 0 } : null)
    } as TearEffect;
  }
  if (form === "scrap") {
    const d = defaultInsetForForm("scrap");
    return {
      type: "tear",
      form: "scrap",
      profile,
      scale: 0,
      seed: other.seed,
      inset: Array.isArray(other.inset) ? [d, d, d, d] : d,
      ...(isTorn ? { roughness: 0, fiber: 0 } : null)
    } as TearEffect;
  }
  const d = defaultAtForSide(side);
  return {
    type: "tear",
    form: "edge",
    side,
    profile,
    scale: 0,
    seed: other.seed,
    at: Array.isArray(other.at) ? [d, d] : d,
    ...(isTorn ? { roughness: 0, fiber: 0 } : null)
  } as TearEffect;
}

function interpolateTear(
  fromRaw: TearEffect | undefined,
  toRaw: TearEffect | undefined,
  p: number
): TearEffect {
  const from = fromRaw ?? neutralTearFor(toRaw!);
  const to = toRaw ?? neutralTearFor(fromRaw!);

  const form = (p < 0.5 ? from.form : to.form) ?? "edge";
  const side = (p < 0.5 ? from.side : to.side) ?? "right";
  const profile = (p < 0.5 ? from.profile : to.profile) ?? "torn";
  const seed = p < 0.5 ? from.seed : to.seed;
  const scale = round2(lerp(from.scale, to.scale, p));

  const fromTorn = from as Partial<TornFields>;
  const toTorn = to as Partial<TornFields>;
  const roughness =
    profile === "torn" ? round2(lerp(fromTorn.roughness ?? 0.6, toTorn.roughness ?? 0.6, p)) : undefined;
  const fiber =
    profile === "torn" ? round2(lerp(fromTorn.fiber ?? 0, toTorn.fiber ?? 0, p)) : undefined;

  const atA = resolveAt(from.at, from.side);
  const atB = resolveAt(to.at, to.side);
  const at0 = round2(lerp(atA[0], atB[0], p));
  const at1 = round2(lerp(atA[1], atB[1], p));
  const isArrayAt = Array.isArray(from.at) || Array.isArray(to.at);
  const at: number | [number, number] = isArrayAt ? [at0, at1] : at0 === at1 ? at0 : [at0, at1];

  const insetA = resolveInset(from.inset, from.form);
  const insetB = resolveInset(to.inset, to.form);
  const ins0 = round2(lerp(insetA[0], insetB[0], p));
  const ins1 = round2(lerp(insetA[1], insetB[1], p));
  const ins2 = round2(lerp(insetA[2], insetB[2], p));
  const ins3 = round2(lerp(insetA[3], insetB[3], p));
  const isArrayInset = Array.isArray(from.inset) || Array.isArray(to.inset);
  const inset: number | EdgeInsets = isArrayInset
    ? [ins0, ins1, ins2, ins3]
    : ins0 === ins1 && ins1 === ins2 && ins2 === ins3
      ? ins0
      : [ins0, ins1, ins2, ins3];

  const enabled = p < 0.5 ? from.enabled : to.enabled;
  if (profile === "torn") {
    return {
      type: "tear",
      form,
      side,
      profile: "torn",
      seed,
      scale,
      roughness: roughness!,
      fiber: fiber!,
      at,
      inset,
      ...(enabled !== undefined ? { enabled } : null)
    };
  }
  return {
    type: "tear",
    form,
    side,
    profile,
    seed,
    scale,
    at,
    inset,
    ...(enabled !== undefined ? { enabled } : null)
  };
}

function interpolateShadow<T extends DropShadowEffect | InnerShadowEffect>(
  from: T | undefined,
  to: T | undefined,
  p: number,
  type: "drop-shadow" | "inner-shadow"
): T {
  const fromOffset = from?.offset ?? { x: 0, y: 0 };
  const toOffset = to?.offset ?? { x: 0, y: 0 };
  const fromBlur = from?.blur ?? 0;
  const toBlur = to?.blur ?? 0;
  const fromSpread = from?.spread ?? 0;
  const toSpread = to?.spread ?? 0;
  const fromColor = from?.color ?? (to?.color ? transparentColor(to.color) : "rgba(0,0,0,0)");
  const toColor = to?.color ?? (from?.color ? transparentColor(from.color) : "rgba(0,0,0,0)");
  const enabled = p < 0.5 ? from?.enabled : to?.enabled;

  return {
    type,
    offset: {
      x: round2(lerp(fromOffset.x, toOffset.x, p)),
      y: round2(lerp(fromOffset.y, toOffset.y, p))
    },
    blur: round2(lerp(fromBlur, toBlur, p)),
    spread: round2(lerp(fromSpread, toSpread, p)),
    color: lerpColor(fromColor, toColor, p),
    blendMode: p < 0.5 ? from?.blendMode : to?.blendMode,
    ...(enabled !== undefined ? { enabled } : null)
  } as T;
}

function interpolateLiquidGlass(
  from: LiquidGlassEffect | undefined,
  to: LiquidGlassEffect | undefined,
  p: number
): LiquidGlassEffect {
  const enabled = p < 0.5 ? from?.enabled : to?.enabled;
  return {
    type: "liquid-glass",
    frost: round2(lerp(from?.frost ?? 0, to?.frost ?? 0, p)),
    refraction: round2(lerp(from?.refraction ?? 0, to?.refraction ?? 0, p)),
    depth: round2(lerp(from?.depth ?? 1, to?.depth ?? 1, p)),
    dispersion: round2(lerp(from?.dispersion ?? 0, to?.dispersion ?? 0, p)),
    lightAngle: round2(lerp(from?.lightAngle ?? 0, to?.lightAngle ?? 0, p)),
    lightIntensity: round2(lerp(from?.lightIntensity ?? 0, to?.lightIntensity ?? 0, p)),
    splay: round2(lerp(from?.splay ?? 0, to?.splay ?? 0, p)),
    ...(enabled !== undefined ? { enabled } : null)
  };
}

export function interpolateEffects(
  fromList: Effect[] | undefined,
  toList: Effect[] | undefined,
  p: number
): Effect[] | undefined {
  const fromActive = (fromList ?? []).filter((e) => e && e.enabled !== false);
  const toActive = (toList ?? []).filter((e) => e && e.enabled !== false);
  if (fromActive.length === 0 && toActive.length === 0) return undefined;

  const fromByType = new Map<string, Effect[]>();
  for (const ef of fromActive) {
    const list = fromByType.get(ef.type) || [];
    list.push(ef);
    fromByType.set(ef.type, list);
  }
  const toByType = new Map<string, Effect[]>();
  for (const ef of toActive) {
    const list = toByType.get(ef.type) || [];
    list.push(ef);
    toByType.set(ef.type, list);
  }

  const allTypes = new Set([...fromByType.keys(), ...toByType.keys()]);
  const result: Effect[] = [];

  for (const type of allTypes) {
    const froms = fromByType.get(type) || [];
    const tos = toByType.get(type) || [];
    const count = Math.max(froms.length, tos.length);

    for (let i = 0; i < count; i++) {
      const f = froms[i];
      const t = tos[i];

      switch (type) {
        case "layer-blur":
          result.push(interpolateLayerBlur(f as LayerBlurEffect | undefined, t as LayerBlurEffect | undefined, p));
          break;
        case "backdrop-blur":
          result.push(interpolateBackdropBlur(f as BackdropBlurEffect | undefined, t as BackdropBlurEffect | undefined, p));
          break;
        case "tear":
          result.push(interpolateTear(f as TearEffect | undefined, t as TearEffect | undefined, p));
          break;
        case "drop-shadow":
          result.push(interpolateShadow(f as DropShadowEffect | undefined, t as DropShadowEffect | undefined, p, "drop-shadow"));
          break;
        case "inner-shadow":
          result.push(interpolateShadow(f as InnerShadowEffect | undefined, t as InnerShadowEffect | undefined, p, "inner-shadow"));
          break;
        case "liquid-glass":
          result.push(interpolateLiquidGlass(f as LiquidGlassEffect | undefined, t as LiquidGlassEffect | undefined, p));
          break;
      }
    }
  }

  return result.length > 0 ? result : undefined;
}
