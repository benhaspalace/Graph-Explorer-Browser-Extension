# Software Bill of Materials (SBOM)

Graph Explorer JSON Query — components shipped in the extension and used to
build/test it. The extension has **no runtime npm dependencies**: every
third-party library is committed to the repository as a pre-built, pinned
bundle under `vendor/`, and its integrity is verified on every build
(`npm run verify:vendor`, backed by `vendor/CHECKSUMS.txt`).

Regenerate the hash column after an intentional bundle update with
`npm run vendor:hash` and review the diff.

## Shipped in the extension (runtime)

| Component | Version | Source (upstream) | License | File | SHA-256 |
| --- | --- | --- | --- | --- | --- |
| jmespath.js | 0.16.0 | https://github.com/jmespath/jmespath.js | MIT | `vendor/jmespath.js` | `a88012bb68aa9e52a316d3be81598573d686cdad226a4c5d3177d720e187fe53` |
| jsonpath-plus | 10.3.0 | https://github.com/JSONPath-Plus/JSONPath | MIT | `vendor/jsonpath-plus.js` | `85667908eee7ca1835b9cdb10e10add3ce9e3cd21bb377c0e143d02656b8bc7c` |
| jqts | 0.0.8 | https://github.com/kentdotn/jqts | MIT | `vendor/jqts.js` | `5d85b85f308efc01b7249573012ab8d8d7c06e9d5b82f5f72ed02210b950c9ce` |
| CodeMirror 6 bundle | see sub-components below | https://codemirror.net | MIT | `vendor/codemirror.js` | `d69baf52717e2feb1515413679de8aa4ba9f6432700c348e6321da89c7db7afa` |

`vendor/codemirror.js` is a single esbuild IIFE bundle of these packages
(rebuild command is in the file's header comment):

| Package | Version | License |
| --- | --- | --- |
| @codemirror/state | 6.7.1 | MIT |
| @codemirror/view | 6.43.8 | MIT |
| @codemirror/language | 6.12.4 | MIT |
| @codemirror/commands | 6.10.4 | MIT |
| @codemirror/autocomplete | 6.20.3 | MIT |
| @lezer/highlight | 1.2.3 | MIT |

First-party code (`src/**`, `popup/**`, `scripts/**`, icons) is original to
this repository (MIT, see `LICENSE`). All query-language tokenizers used by
the editor are first-party (`nextQueryToken` in `src/query-utils.js`), not
part of the CodeMirror bundle.

## Build / test only (never shipped)

| Component | Version | Purpose | Notes |
| --- | --- | --- | --- |
| playwright | 1.56.1 (pinned) | Offline end-to-end smoke test | Installed ad hoc in CI with `--ignore-scripts`; not a dependency of the extension and not present in any release artifact |
| Node.js | 22 (CI) | Runs the unit tests (`node:test`) and build scripts | No other test framework |

There is intentionally **no `package-lock.json`**: the shipped extension has
zero npm dependencies, and the only build/test tool (Playwright) is pinned by
exact version at its single install site.

## Verifying this SBOM against a checkout or a release

```bash
npm run verify:vendor        # recompute vendored hashes vs vendor/CHECKSUMS.txt
sha256sum vendor/*.js        # compare against the SHA-256 column above
```

For a downloaded release, additionally verify the release zip's checksum and
its build-provenance attestation — see [SECURITY.md](SECURITY.md).
