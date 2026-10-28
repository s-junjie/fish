import { ColorFilter } from "../../core/dsl/types";
import { colorFilterPrimitives } from "../../core/dsl/color-filter";

/**
 * Appends the colour-adjustment primitives for `filter` to `primitives` and
 * returns the name of the last pass, or `input` unchanged when there is nothing
 * to apply.
 *
 * Shared by the canvas `<defs>` and the inspector's live preview so both paint
 * an identical chain — a second copy would be free to drift from what the user
 * actually gets.
 */
export function appendColorFilterNodes(
  primitives: any[],
  filter: ColorFilter | undefined,
  input: string,
  idPrefix: string
): string {
  let current = input;
  colorFilterPrimitives(filter).forEach((p, i) => {
    const result = `${idPrefix}-${i}`;
    if (p.kind === "linear-transfer") {
      primitives.push(
        <feComponentTransfer key={result} in={current} result={result}>
          <feFuncR type="linear" slope={p.slope} intercept={p.intercept} />
          <feFuncG type="linear" slope={p.slope} intercept={p.intercept} />
          <feFuncB type="linear" slope={p.slope} intercept={p.intercept} />
        </feComponentTransfer>
      );
    } else if (p.kind === "tone-curve") {
      const tableValues = p.table.join(" ");
      primitives.push(
        <feComponentTransfer key={result} in={current} result={result}>
          <feFuncR type="table" tableValues={tableValues} />
          <feFuncG type="table" tableValues={tableValues} />
          <feFuncB type="table" tableValues={tableValues} />
        </feComponentTransfer>
      );
    } else if (p.kind === "hue-rotate") {
      primitives.push(
        <feColorMatrix key={result} in={current} result={result} type="hueRotate" values={String(p.degrees)} />
      );
    } else if (p.kind === "saturate") {
      primitives.push(
        <feColorMatrix key={result} in={current} result={result} type="saturate" values={String(p.value)} />
      );
    } else {
      primitives.push(
        <feColorMatrix key={result} in={current} result={result} type="matrix" values={p.values.join(" ")} />
      );
    }
    current = result;
  });
  return current;
}
