<!--
Thanks for the pull request. Keep it to one topic, and see CONTRIBUTING.md for
setup, code style, and the security invariants below.
Security vulnerability? Do not open a PR — follow SECURITY.md.
-->

## What this changes

<!-- The user-visible effect in a sentence or two, and why. -->

Fixes #

## How it works

<!-- The approach, and anything a reviewer would otherwise have to reverse-engineer:
     new state, new messages between contexts, touched files. -->

## How it was tested

<!-- Commands you ran, plus what you clicked through in Graph Explorer:
     browser + version, query language, dataset shape/size, settings that matter. -->

- [ ] `npm test` (unit tests + vendored-checksum verification)
- [ ] `npm run e2e` (offline smoke test) — or N/A, explain why
- [ ] Loaded unpacked and exercised the change in Graph Explorer
- [ ] Checked light **and** dark theme (UI changes)

## Security invariants

These hold in this change (see [SECURITY.md](../SECURITY.md)):

- [ ] No `eval`/`new Function`, no remote code, no `innerHTML`/`insertAdjacentHTML`/`document.write` — DOM built via `createElement`/`textContent`
- [ ] No new permissions and no widened host access
- [ ] No new network requests (Graph `@odata.nextLink` paging remains the only outbound traffic)
- [ ] No credentials read, logged, or persisted; header sanitization intact
- [ ] No response bodies persisted to `chrome.storage`
- [ ] No new runtime dependencies; `vendor/` unchanged, or updated per CONTRIBUTING.md with `SBOM.md` + `vendor/CHECKSUMS.txt` refreshed

## Docs and version

- [ ] `README.md` updated for user-visible behavior (feature list / settings table), or not applicable
- [ ] Version bumped in **both** `manifest.json` and `package.json`, or left for a maintainer
