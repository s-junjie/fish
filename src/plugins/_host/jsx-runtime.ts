/**
 * `jsx: "automatic"` makes the compiler emit `import { jsx } from "preact/jsx-runtime"`,
 * and that bare specifier cannot resolve inside a `blob:` module. The plugin build
 * aliases it here, so the emitted calls land on the shell's own jsx runtime instead
 * of pulling a second copy of Preact into the bundle.
 */
export { jsx, jsxs, Fragment } from "./index";
