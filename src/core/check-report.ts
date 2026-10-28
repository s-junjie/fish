import type { CompileDiagnostic } from "./compile";
import type { DesignDocument } from "./dsl/types";
import { normalizeDesignDocument } from "./dsl/normalize";
import type { NormalizationRepair } from "./dsl/normalize/shared";
import { validateDocument } from "./validate";
import { geometryReport, type GeometryFinding } from "./geometry-report";
import { layoutDefects } from "./layout-debug";
import { checkVerdict } from "./check-verdict";
import type { InkFinding } from "./audit/text-ink";

export type CheckLevel = "error" | "warning" | "info";
export type CheckSource = "normalize" | "validate" | "geometry" | "ink";

export interface CheckFinding {
  source: CheckSource;
  level: CheckLevel;
  message: string;
  elementId?: string;
  /** The engine's own rule name, when it has one (repair kind, ink rule, …). */
  code?: string;
  /** A JSON-pointer-ish repair path, when the finding came from normalization. */
  path?: string;
}

export interface CheckInkReport {
  measured: boolean;
  fontsReady: boolean;
  zoom: number;
  checked: number;
  skipped: Array<{ elementId: string; reason: string }>;
  findings: InkFinding[];
}

export interface CheckReport {
  ok: boolean;
  counts: Record<CheckLevel, number>;
  repairs: NormalizationRepair[];
  lossyRepairs: number;
  findings: CheckFinding[];
  failReason: string;
  geometry?: GeometryFinding[];
  ink?: CheckInkReport;
}

export interface RunCheckOptions {
  /** The input is authored JSON that still needs normalizing. */
  candidate?: boolean;
  strict?: boolean;
  /** Default true: the layout report is measurements, not a verdict. */
  geometry?: boolean;
}

export interface RunCheckResult {
  document: DesignDocument;
  repairs: NormalizationRepair[];
  diagnostics: CompileDiagnostic[];
  geometry: GeometryFinding[];
  report: CheckReport;
}

const repairFinding = (repair: NormalizationRepair): CheckFinding => ({
  source: "normalize",
  level: repair.severity === "info" ? "info" : "warning",
  message: repair.message,
  path: repair.path,
  code: repair.kind
});

const diagnosticFinding = (diagnostic: CompileDiagnostic): CheckFinding => ({
  source: "validate",
  level: diagnostic.level,
  message: diagnostic.message,
  ...(diagnostic.elementId ? { elementId: diagnostic.elementId } : {})
});

const geometryFinding = (finding: GeometryFinding): CheckFinding => ({
  source: "geometry",
  level: finding.level,
  message: finding.message,
  ...(finding.elementId ? { elementId: finding.elementId } : {}),
  code: finding.kind
});

const layoutFinding = (entry: {
  id: string;
  name: string;
  delta: number;
  height: number;
}): CheckFinding => ({
  source: "geometry",
  level: "warning",
  message: `Auto-layout "${entry.name || entry.id}" content is ${entry.delta}px taller than its ${entry.height}px box`,
  elementId: entry.id,
  code: "layout-overflow"
});

/**
 * The one verdict every check path reaches.
 *
 * `findings` are the things a reader can act on; `repairs` stay beside them
 * because a lossy repair may have no finding of its own, yet still fails the
 * document. `checkVerdict` owns the rule that only a lossy repair fails.
 */
export function buildCheckReport(
  findings: CheckFinding[],
  repairs: NormalizationRepair[],
  strict: boolean,
  extra: { geometry?: GeometryFinding[]; ink?: CheckInkReport } = {}
): CheckReport {
  const counts: Record<CheckLevel, number> = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) counts[finding.level]++;

  const { ok, lossy, failReason } = checkVerdict(repairs, counts.error, counts.warning, strict);

  return {
    ok,
    counts,
    repairs,
    lossyRepairs: lossy,
    findings,
    failReason,
    ...(extra.geometry ? { geometry: extra.geometry } : {}),
    ...(extra.ink ? { ink: extra.ink } : {})
  };
}

/** Append findings after the fact (the ink audit runs against the live page). */
export function withFindings(
  report: CheckReport,
  extra: CheckFinding[],
  strict: boolean,
  extraFields: { ink?: CheckInkReport } = {}
): CheckReport {
  const ink = extraFields.ink ?? report.ink;
  return buildCheckReport([...report.findings, ...extra], report.repairs, strict, {
    ...(report.geometry ? { geometry: report.geometry } : {}),
    ...(ink ? { ink } : {})
  });
}

/**
 * Normalize (when the input is authored JSON), then run the three checks that
 * need no DOM. Browser-only measurements are appended by the caller.
 */
export function runCheck(input: unknown, options: RunCheckOptions = {}): RunCheckResult {
  const { document, repairs } = options.candidate
    ? normalizeDesignDocument(input)
    : { document: input as DesignDocument, repairs: [] as NormalizationRepair[] };

  const diagnostics = validateDocument(document);
  const measured: GeometryFinding[] =
    options.geometry === false
      ? []
      : geometryReport(document);

  const findings: CheckFinding[] = [
    ...repairs.map(repairFinding),
    ...diagnostics.map(diagnosticFinding),
    ...measured.map(geometryFinding),
    ...(options.geometry === false ? [] : layoutDefects(document).map(layoutFinding))
  ];

  return {
    document,
    repairs,
    diagnostics,
    geometry: measured,
    report: buildCheckReport(findings, repairs, options.strict ?? false, {
      ...(options.geometry === false ? {} : { geometry: measured })
    })
  };
}
