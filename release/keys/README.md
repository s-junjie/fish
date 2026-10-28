# Release public keys

These are the two trust anchors a published shell carries. They are public by
definition — every shell embeds them — and they are kept here so a reader can
compare a download against the repository without trusting the download.

| File | Trusts | Embedded by |
|---|---|---|
| `update-public.json` | Manifest signatures, checked before a shell replaces itself | `FISH_UPDATE_PUBLIC_KEY` at build time |
| `plugin-public.json` | Plugin signatures, checked before a bundle installs | `FISH_PLUGIN_PUBLIC_KEY`, or derived from `FISH_PLUGIN_PRIVATE_KEY` |

Both are P-256 (secp256r1) JWKs. They are different keys on purpose: an update key
that could also sign plugins would let one compromise do both.

## Thumbprints (RFC 7638)

```text
update  rbeJtIPcOr208xq1MclXzUeEwcgra3dZWBIbpUQ0aB8
plugin  0nj8GbvND1_8r1ahEFpaNBOZYKiwoKR5ubIFWAfbJik
```

To recompute:

```bash
node -e '
const c = require("node:crypto"), fs = require("node:fs");
for (const f of ["update-public.json", "plugin-public.json"]) {
  const j = JSON.parse(fs.readFileSync(`release/keys/${f}`));
  const t = c.createHash("sha256")
    .update(JSON.stringify({ crv: j.crv, kty: j.kty, x: j.x, y: j.y }))
    .digest("base64url");
  console.log(f, t);
}'
```

## The private halves are not here

They live in the `release` GitHub environment as `FISH_UPDATE_PRIVATE_JWK` and
`FISH_PLUGIN_PRIVATE_KEY`, plus an offline backup outside this repository. Never
commit them, never paste them into an issue, and never sign a public plugin with
the development key (`.fish-plugin-key.json`).

Rotating either key costs a shell rebuild on every user's disk. See
[`docs/RELEASING.md`](../../docs/RELEASING.md) § Key rotation.
