/**
 * The implementation lives in `./instance-resolve`, beside `resolveInstanceContent`
 * and the override commit that measure with it — a module there importing this one
 * would close a cycle. This barrel keeps every caller's import path stable.
 */
export { instanceSizeResolver } from "./instance-resolve";
