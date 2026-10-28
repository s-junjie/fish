/** @type {import('tailwindcss').Config} */
import {
  color,
  cssVariables,
  duration,
  easing,
  radius,
  shadow
} from "./tailwind.tokens.js";

/**
 * FISH workbench theme.
 *
 * One rule governs the whole palette: the chrome is NEUTRAL GREY and the
 * brand amber is the only saturated hue in it. Neutral means neutral — the
 * ramp below measures 0–1/255 of channel spread, i.e. no perceptible tint.
 * An earlier tinted "deep water" ramp measured 8.8 and read as blue-black,
 * which is a different (and worse) surface than this one.
 *
 * The brand colour is deliberately SCOPED. It marks exactly two things:
 * an armed tool, and a commit/destructive action. Layer selection is a
 * state, not an action, so it wears a neutral wash — see `selection`.
 *
 * Amber sits close to the canvas measurement coral (#EF4444, 0.37
 * perceptual distance). That is accepted: coral only paints while Alt is
 * held (`MeasurementOverlay.tsx`), amber is always on. They do not coexist.
 */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}"
  ],
  theme: {
    extend: {
      /* ── Type ──────────────────────────────────────────────────────────
         Four steps, and they are not interchangeable. The gap between
         `micro` and `readout` is what gives a panel a focal point; before
         this the whole UI ran on 10/11/12px and read as undifferentiated.
         `readout` is the only step that carries numbers, and it is always
         tabular so digits do not shift while scrubbing. */
      fontFamily: {
        /* System stacks only. A webfont would add bytes to a file that ships
           inside every saved design, and `src/core/font-diagnostics.ts` already
           flags a family that is assumed instead of shipped — so nothing here
           may name one we do not ship.

           `mono` is the shell's DEFAULT voice: `src/style.css` sets it on
           `html`, so every string that does not ask otherwise speaks it.
           `sans` is kept for an explicit `font-sans` opt-in and currently has
           no consumer — see DESIGN.md §Typography and the note in
           `src/style.css` for why the default was flipped (short version: a
           `fontSize` tuple cannot carry a family, so the two-family split was
           never implemented, and the reference layout was mono-first anyway). */
        sans: ["system-ui", "-apple-system", "BlinkMacSystemFont", "Segoe UI",
               "Roboto", "Helvetica Neue", "Arial", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "SF Mono", "Menlo", "Consolas",
               "Liberation Mono", "monospace"],
      },
      /* The whole scale, with each step's tracking taken from the reference
         layout. Tracking is not decoration here: it is what keeps a 9px
         uppercase header legible, and what stops a 10.5px mono value from
         looking loose beside a 12px sans label. Sizes alone produced the
         panel's earlier flatness — the same 12px with and without tracking
         reads as two different intentions. */
      fontSize: {
        /* Section headers: the widest tracking in the app, because UPPERCASE
           at 9px needs the air or it turns into a grey smear. */
        micro: ["9px", { lineHeight: "1", letterSpacing: "0.18em", fontWeight: "600" }],
        /* Body text and prose labels. No tracking. */
        ui: ["12px", { lineHeight: "1.45" }],
        /* Every NUMBER. Tabular so digits do not shift width while a scrub or
           a drag runs, and tight because a mono digit already carries its own
           rhythm. */
        readout: ["12px", { lineHeight: "1.2", letterSpacing: "-0.02em" }],
        /* Document name and the inspector's subject line. */
        display: ["15px", { lineHeight: "1.2", letterSpacing: "-0.01em", fontWeight: "600" }],
        displaySm: ["13px", { lineHeight: "1.2", letterSpacing: "-0.01em", fontWeight: "600" }],
        /* Layer-row labels and the panel tabs. Mono, slightly tracked: this is
           the list the eye scans fastest, so it gets the engineering voice. */
        row: ["10.5px", { lineHeight: "1.3", letterSpacing: "-0.01em" }],
        tab: ["11px", { lineHeight: "1.3", letterSpacing: "0.02em" }],
        /* A unit, an axis suffix, or a field's own KEY — `px`, `deg`, `X`, `W`.
           The smallest step in the app, and deliberately so: none of them may
           compete with the value they qualify, so they share one step rather
           than splitting 9px from 8.5px. */
        unit: ["8.5px", { lineHeight: "1", letterSpacing: "0.04em" }],
        /* A hex/colour readout. */
        code: ["10px", { lineHeight: "1.2", letterSpacing: "0" }],
        /* A percentage or alpha figure beside a hex. */
        meta: ["9.5px", { lineHeight: "1.2", letterSpacing: "0" }],
        /* The type badge on the title bar and the inspector's subject type. */
        tag: ["8.5px", { lineHeight: "1", letterSpacing: "0.1em" }],
      },

      /* ── Shape ──────────────────────────────────────────────────────────
         A panel and a control must not share a radius; that equality is
         what makes a UI read as undifferentiated boxes. Dock-only pill. */
      borderRadius: {
        panel: radius("panel"),
        ctl: radius("ctl"),
        swatch: radius("swatch"),
        pill: radius("pill"),
        /* The dock is the one place a radius exceeds the panel: a 14px
           container around 10px buttons reads as a squircle, which is what
           the reference layout draws and what the dock's larger targets
           need. Tokenised so the pair is not stranded as `rounded-[14px]` /
           `rounded-[10px]` in the toolbar, where no theme change could
           reach them. */
        dock: radius("dock"),
        "dock-ctl": radius("dock-ctl"),
      },

      /* ── Depth ──────────────────────────────────────────────────────────
         Three tiers, always paired with a 1px hairline. `hair` is the top
         inner highlight that reads as a lit edge rather than a painted one. */
      boxShadow: {
        panel: shadow("panel"),
        popover: shadow("popover"),
        modal: shadow("modal"),
      },

      /* ── Motion ─────────────────────────────────────────────────────────
         Two curves, declared once. No animation library: the shell has
         36.5KB of headroom and a spring bundle would spend it. `snap` is
         for state that must feel instantaneous; `slide` for panels whose
         position carries meaning. Durations are short on purpose — a
         design tool is held all day. */
      transitionDuration: {
        micro: duration("micro"),
        base: duration("base"),
        slide: duration("slide"),
      },
      transitionTimingFunction: {
        snap: easing("snap"),
        slide: easing("slide"),
      },
      keyframes: {
        /* Popovers and menus scale from the edge that triggered them, so
           they read as growing out of their owner. Written by hand because
           the transform-origin has to be set inline per placement. */
        "pop-in": {
          from: { opacity: "0", transform: "scale(.97)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        /* The autosave dot. Slow enough to read as "working", not "blinking". */
        "pulse-soft": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: ".45" },
        },
      },
      animation: {
        "pop-in": `pop-in ${duration("micro")} ${easing("snap")}`,
        "fade-in": `fade-in ${duration("base")} ${easing("snap")}`,
        "pulse-soft": `pulse-soft ${duration("pulse")} ${easing("soft")} infinite`,
      },

      colors: {
        /* ── Neutral ramp ────────────────────────────────────────────────
           Measured tint 0–1/255. paper sits above nothing and is the
           window floor; the canvas paints its own colour over it. */
        paper: color("paper"),
        panel: color("panel"),
        surface: color("surface"),
        raised: color("raised"),
        /* A control INSIDE a panel that sits on the panel surface rather than
           in it: the alignment grid's cells, a segmented button. Matches the
           demo's `--field` exactly. */
        field: color("field"),
        /* The ARMED segment of a segmented control — the one swatch inside a
           `field` track. It needs its own step because the theme has no neutral
           between `field` (#242424) and `raised` (#242428): four units apart,
           which is a selected state you cannot see, and `surface` is DARKER
           than the track, which reads as recessed rather than chosen. Neutral,
           like the rest of the chrome — the amber wash meant "armed TOOL", and
           a two-way switch is not a tool. `ink` on it measures 11.9:1. */
        "field-active": color("field-active"),
        /* The RECESSED well — every text entry sits here, not on `field`.
           The demo draws an input as `background: var(--well)` plus
           `inset 0 1px 2px rgba(0,0,0,.45)`, which is what makes it read as
           pressed into the panel; a lighter fill reads as a control laid on
           top. `ScrubInput`, `ColorField` and `ColorPanel` all use this plus
           the inset shadow, in that combination. */
        inset: color("inset"),
        rule: color("rule"),
        "rule-strong": color("rule-strong"),

        /* ── Text ────────────────────────────────────────────────────────
           Cold, not neutral: the marine hue (245°) at 40% chroma, L*-matched
           to the neutral greys these replaced — 15.9:1 / 7.0:1 / 3.3:1 on
           `panel` is unchanged. The hue is load-bearing: 245° is 45° off
           `canvas-select` (290°), so ink never reads as a selection colour.
           `muted` is for disabled affordances only — it does not clear AA. */
        ink: { DEFAULT: color("ink"), dim: color("ink-dim"), muted: color("ink-muted") },

        /* The hairline a colour swatch wears. White at 16% rather than a fixed
           grey: a swatch is an unknown colour at author time, so the edge has to
           be relative to whatever is under it — `rule-strong` disappears on a
           dark swatch and barely shows on a light one. */
        "swatch-ring": color("swatch-ring"),

        /* ── The brand colour ────────────────────────────────────────────
           8.23:1 on panel. Scoped to an armed tool and a commit. */
        brand: color("brand"),
        "brand-wash": color("brand-wash"),
        "brand-ink": color("brand-ink"),
        /* On-brand ink for a PICTURE FILL, one step up `brand-ink`. A solid
           silhouette covers about a third of a 36×22 glyph, so at 7.6:1 the
           blocks became the darkest mass in the menu — a black hole beside the
           12px label wearing the same ink. 5.1:1 is still the darkest thing on
           the row, and no longer reads as a void. Hairlines stay on
           `brand-ink`: at 0.8px this value disappears. */
        "brand-ink-soft": color("brand-ink-soft"),

        /* ── Canvas semantic colours ──────────────────────────────────────
           These carry PRODUCT meaning and are never restyled for looks.
           `canvas-select` is Ocean Electric Blue for vector paths & selection. */
        "canvas-select": color("canvas-select"),
        /* Figma marks components and instances with violet. Lifted from
           #9747FF, which measured 3.94:1 on `panel` — below AA. The hue
           is unchanged, so "violet means component" still reads. */
        component: color("component"),
        /* Snap guides, measurement and geometric warnings. Unified Coral accent. */
        coral: color("coral"),
        "snap-pink": color("snap-pink"),
        "measure-coral": color("measure-coral"),

        /* ── Layer-row states ─────────────────────────────────────────────
           The selected row wears the demo's amber wash. Earlier this was a
           neutral #242830 on the reasoning that a selection is a "state, not
           an action" — but a neutral wash on a #181818 panel is a 4% step
           that reads as "slightly different grey" rather than as selected,
           and the layer list is the one place a user must never have to
           hunt for the selection. The brand rule still holds where it
           matters: nothing here is a COMMIT, and the canvas selection keeps
           its own blue.
           The wash alone was too quiet, so the selected row also carries an
           inset indicator bar — see `LayerTree.tsx`. It is deliberately NOT
           an edge mark: the row is a rounded chip, and a 4px corner arc cuts
           a full-height 2px bar into a diagonal wedge. */
        selection: color("selection"),
        "selection-hover": color("selection-hover"),
        /* The container behind a selected node's DESCENDANTS. Deliberately a
           THIRD of the row's wash. It first reused `brand-wash` — the same 12%
           as the row itself — which put parent and children at identical
           strength and merged them into one undifferentiated amber mass with
           no hierarchy to read. 6% was still loud enough to compete with the
           row; 4% reads as a region without becoming a second selection. The
           selected row must stay the strongest mark in the list. */
        "selection-subtree": color("selection-subtree"),

        /* ── The opaque equivalents ──────────────────────────────────────
           The row-action buttons (lock/eye) are absolutely positioned over
           the row's right end, so they must OCCLUDE the truncated layer
           name: a transparent button lets the text show through the gaps
           between the glyphs.

           But a translucent button nested in an already-tinted row
           COMPOSITES. `bg-selection` on a row that is itself `bg-selection`
           paints 12% over 12% ≈ 22.6%, and that extra step is exactly the
           darker box that appeared around the lock/eye on a selected row.
           The row-action surface therefore uses the PRE-COMPOSITED colour —
           precisely what the row already shows, painted opaquely. Identical
           pixels, no box, and the name is still covered.

           These three are DERIVED, not chosen. Recompute them if `panel` or
           the amber wash changes:
             selection-solid               = selection        over panel
             selection-subtree-solid       = selection-subtree over panel
             selection-subtree-hover-solid = selection-hover  over selection-subtree over panel */
        "selection-solid": color("selection-solid"),
        "selection-subtree-solid": color("selection-subtree-solid"),
        "selection-subtree-hover-solid": color("selection-subtree-hover-solid"),

        /* The paint ROW's idle and open borders. Idle is `rule` on purpose: a
           paint row and a style card are the same 30px object with the same
           `surface` fill, and a hairline a step brighter on one of them made two
           identical cards read as two different species. The reference layout
           draws `.paint` as `inset 0 0 0 1px var(--rule)` for the same reason.
           They are still held apart from `rule`, because both are appended to
           the same element and two competing `border-*` utilities resolve by
           stylesheet order, not class order — folding them into one value makes
           the open state invisible. */
        "paint-row-rule": color("paint-row-rule"),
        "paint-row-rule-open": color("paint-row-rule-open"),
      },
    },
  },
  plugins: [
    ({ addBase }) => {
      addBase({ ":root": cssVariables() });
    }
  ],
}