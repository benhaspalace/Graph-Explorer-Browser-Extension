# Graph Explorer JSON Query

A browser extension for **Chrome** and **Microsoft Edge** that adds JSON query
capabilities to [Microsoft Graph Explorer](https://developer.microsoft.com/en-us/graph/graph-explorer).
Run a Graph query, then filter, reshape, sort, and export the JSON response
with [JMESPath](https://jmespath.org/) — the same query language as Azure CLI's
`--query` option.

![The query panel embedded in Graph Explorer's results area](docs/screenshot.png)

## Features

- **Split results view** — the Graph Explorer results area splits in half:
  the original response stays on the left, and the query tool takes the right,
  with the query input on top and the live result underneath.
- **JMESPath queries** — filter (`value[?jobTitle == 'Auditor']`), project
  (`value[].{name: displayName, email: mail}`), sort, slice, count, and pipe,
  with results updating live as you type.
- **Response history** — the last 25 Graph responses are kept (in memory only);
  pick any of them from the dropdown to query it.
- **Smart suggestions** — one-click query chips generated from the shape of the
  current response, plus a built-in cheat sheet.
- **Export** — copy the result as JSON, copy it as CSV (great for Excel), or
  download it as a `.json` file.
- **Paste JSON** — paste any JSON document to query it, even without running a
  Graph request.
- **All Graph clouds** — captures responses from `graph.microsoft.com`,
  US Government and China endpoints, and Graph Explorer's sample-tenant proxy
  used when you're not signed in.
- **Resilient** — if Microsoft ever changes Graph Explorer's page structure,
  the panel automatically falls back to a floating side drawer toggled from the
  bottom-right corner.

## Installation (load unpacked)

The extension is plain JavaScript — no build step.

1. Clone or [download](https://github.com/benhaspalace/Graph-Explorer-Browser-Extension/archive/refs/heads/main.zip) this repository.
2. **Chrome:** open `chrome://extensions` · **Edge:** open `edge://extensions`.
3. Enable **Developer mode** (Chrome: toggle top-right; Edge: toggle in the left sidebar).
4. Click **Load unpacked** and select the repository folder (the one containing `manifest.json`).
5. Open [Graph Explorer](https://developer.microsoft.com/en-us/graph/graph-explorer) and run any query.

Requires Chrome/Edge 111 or newer.

## Usage

1. Run a query in Graph Explorer, e.g. `GET /v1.0/users`.
2. The response area splits and the **JSON Query** panel appears on the right
   (if you hid it, click the **{;} JSON Query** button in the bottom-right corner).
3. Type a JMESPath expression in the top box — the result renders below as you
   type. An empty query shows the whole response.
4. Use **Copy JSON**, **Copy CSV**, or **Download** to export the result.

### Query examples

| Query | What it does |
| --- | --- |
| `value[].displayName` | Pluck one field from every item |
| `value[?startswith(displayName, 'A')]` | Filter items |
| `value[].{name: displayName, email: mail}` | Reshape into smaller objects |
| `sort_by(value, &displayName)[].displayName` | Sort by a field |
| `length(value)` | Count items |
| `value[?jobTitle == 'Auditor'].mail \| [0]` | Filter, project, take first |
| `"@odata.nextLink"` | Read a key containing special characters |

See the [JMESPath tutorial](https://jmespath.org/tutorial.html) for the full language.

## How it works

- `src/interceptor.js` runs in the page's MAIN world at `document_start` and
  wraps `window.fetch`/`XMLHttpRequest`. JSON responses from Microsoft Graph
  endpoints are forwarded to the content script via `window.postMessage`.
- `src/content.js` renders the panel inside a ShadowRoot and embeds it into
  Graph Explorer's results area (`#response-area`), splitting it 50/50. A
  `MutationObserver` re-attaches the panel whenever Graph Explorer's React app
  re-renders that area.
- `vendor/jmespath.js` is the unmodified [jmespath.js](https://github.com/jmespath/jmespath.js)
  library (v0.16.0, MIT) which evaluates the queries.

### Privacy

Everything runs locally in your browser. The extension makes no network
requests of its own, captured responses live only in the page's memory (cleared
on reload), and nothing is ever sent anywhere. The only thing persisted (via
`chrome.storage.local`) is your last query text and whether the panel is
collapsed. Access tokens are never read or stored.

## Development

```bash
npm test        # unit tests (node:test, no dependencies)
npm run icons   # regenerate icons/ from scripts/make-icons.js
npm run package # zip the extension into dist/ for store submission
```

The repository root is the extension — edit, then hit **Reload** on the
extensions page to pick up changes.

### Repository layout

```
manifest.json        Manifest V3 (Chrome + Edge)
src/interceptor.js   MAIN-world fetch/XHR interceptor
src/content.js       Panel UI (isolated world, ShadowRoot)
src/content.css      Panel styles (light + dark theme)
src/query-utils.js   Pure helpers, shared with unit tests
vendor/jmespath.js   Vendored JMESPath engine (MIT)
popup/               Toolbar popup with quick instructions
scripts/make-icons.js Icon generator (no dependencies)
test/                Unit tests (`node --test`)
```

## Future ideas

- Additional query languages (JSONPath, jq). JMESPath is currently the only
  engine; if a second one is added, a settings selector will let you choose
  the language per the original design.
- Query history / saved favorite queries.
- Auto-fetch of `@odata.nextLink` pages before querying.

## License

MIT — see [LICENSE](LICENSE). The vendored `jmespath.js` is © James
Saryerwinnie, MIT licensed.
