/**
 * Graph Explorer JSON Query — panel UI.
 *
 * Runs in the extension's isolated world. Receives captured Graph
 * responses from src/interceptor.js (MAIN world) via window.postMessage
 * and renders a JMESPath query panel over them.
 *
 * Layout: the panel embeds into Graph Explorer's results area
 * (#response-area), splitting it in half — Graph Explorer's own response
 * view on the left, the query tool on the right (query input on top,
 * results underneath). If that anchor ever disappears (site redesign),
 * the panel automatically falls back to a floating drawer toggled by a
 * button in the bottom-right corner.
 *
 * The UI lives inside a ShadowRoot so Graph Explorer's styles and the
 * panel's styles never interfere with each other. All DOM is built with
 * createElement/textContent — no innerHTML — so the script also works on
 * pages that enforce Trusted Types.
 */
(function () {
  'use strict';

  var MESSAGE_SOURCE = 'gejq-interceptor';
  var SETTINGS_SOURCE = 'gejq-settings';
  var EMBED_ANCHOR_ID = 'response-area';
  var MAX_HISTORY = 25;
  var HIGHLIGHT_LIMIT = 300000; // chars of JSON to syntax-highlight
  var RENDER_LIMIT = 2000000; // chars of JSON to render at all
  var STORAGE_KEY_QUERY = 'gejq.lastQuery';
  var STORAGE_KEY_COLLAPSED = 'gejq.embedCollapsed';
  var STORAGE_KEY_FORMAT = 'gejq.exportFormat';
  var STORAGE_KEY_COPY_FORMAT = 'gejq.copyFormat';
  var STORAGE_KEY_SPLIT = 'gejq.splitPct';
  var STORAGE_KEY_SETTINGS = 'gejq.settings';
  var STORAGE_KEY_QUERY_HISTORY = 'gejq.queryHistory';
  var AUTO_SIGNIN_GUARD = 'gejq.autoSignInAttempted';
  // The signed-out "profile view" button in Graph Explorer's top bar —
  // clicking it starts the sign-in flow.
  var SIGN_IN_SELECTORS = ['button[aria-label="Sign in" i]', 'button[aria-label="sign in to graph explorer" i]'];

  var LANGUAGES = {
    jmespath: {
      label: 'JMESPath',
      docsUrl: 'https://jmespath.org/',
      docsHost: 'jmespath.org',
      blurb: 'Queries use JMESPath — the same language as Azure CLI’s --query. Full spec and interactive tutorial at ',
      placeholder: 'JMESPath query — e.g. value[].displayName (empty = whole response)',
      examples: [
        { query: 'value[].displayName', label: 'Pluck one field from every item' },
        { query: "value[?contains(displayName, 'a')]", label: 'Filter items' },
        { query: 'value[].{name: displayName, email: mail}', label: 'Reshape objects' },
        { query: 'sort_by(value, &displayName)[].displayName', label: 'Sort' },
        { query: 'length(value)', label: 'Count items' }
      ]
    },
    jsonpath: {
      label: 'JSONPath',
      docsUrl: 'https://github.com/JSONPath-Plus/JSONPath#syntax-through-examples',
      docsHost: 'jsonpath-plus docs',
      blurb: 'Queries use JSONPath (via jsonpath-plus). Results are always the array of matches. Syntax reference at ',
      placeholder: 'JSONPath query — e.g. $.value[*].displayName (empty = whole response)',
      examples: [
        { query: '$.value[*].displayName', label: 'Pluck one field from every item' },
        { query: "$.value[?(@.jobTitle == 'Auditor')]", label: 'Filter by value' },
        { query: '$.value[?(@.mail)]', label: 'Items where a field exists' },
        { query: '$..displayName', label: 'Recursive descent' },
        { query: '$.value.length', label: 'Count items' }
      ]
    },
    jq: {
      label: 'jq',
      docsUrl: 'https://jqlang.org/manual/',
      docsHost: 'jqlang.org',
      blurb: 'Queries use jq syntax (via the pure-JS jqts engine — core jq features, not every builtin). Manual at ',
      placeholder: 'jq query — e.g. .value[].displayName (empty = whole response)',
      examples: [
        { query: '.value[].displayName', label: 'Pluck one field from every item' },
        { query: '.value | map(select(.jobTitle == "Auditor"))', label: 'Filter by value' },
        { query: '[.value[] | {name: .displayName, email: .mail}]', label: 'Reshape objects' },
        { query: '.value | sort_by(.displayName) | .[].displayName', label: 'Sort' },
        { query: '.value | length', label: 'Count items' }
      ]
    }
  };

  var state = {
    responses: [], // newest first: {id, method, url, status, timestamp, json, size, tooLarge, manual}
    selectedId: null,
    followLatest: true,
    query: '',
    embedded: false, // panel currently lives inside #response-area
    open: false, // panel visible (embedded: expanded; floating: drawer open)
    collapsedPref: false, // user preference: keep the embedded panel hidden
    format: 'json', // result view + export format: 'json' | 'csv' | 'tree'
    copyFormat: 'csv', // delimiter for Copy/Download in CSV mode: 'csv' | 'tsv'
    tableSort: { column: null, dir: 1 }, // table-view sorting (csv mode)
    lastValue: undefined, // last successful query result (sort re-render)
    lastRenderKey: '', // response id + query — resets table sorting
    diff: { active: false, baseId: null }, // compare-mode state
    diffText: '', // exportable text of the last rendered diff
    splitPct: 50, // width of the embedded panel as % of the results area
    settings: GEJQ.normalizeSettings(null), // fresh mutable copy of the defaults
    queryHistory: [], // executed queries, newest first (persisted)
    historyFilter: { text: '', sinceMs: 0, tags: [] }, // panel-session only
    lastOutcome: null, // result of the last runQuery evaluation (avoids re-running)
    lastOutcomeKey: '', // (response, language, query) the evaluation belongs to
    graphEqOpen: false // Graph (OData) equivalent panel visibility
  };

  var ui = null; // populated by buildUi()
  var runTimer = null;
  var embedTimer = null;
  var queryStoreTimer = null; // debounces per-keystroke query persistence
  var manualCounter = 0;
  var lastRunInteraction = 0; // when the user last ran a query in Graph Explorer
  var autocomplete = { open: false, result: null, activeIndex: 0 }; // query-input completion state
  var fetchProgress = null; // latest auto-fetch progress payload (null = idle)
  var suggestionsCache = { key: '', json: undefined }; // skips redundant re-renders

  // ---------------------------------------------------------------- storage

  function storageGet(keys, callback) {
    try {
      chrome.storage.local.get(keys, function (items) {
        callback(items || {});
      });
    } catch (e) {
      callback({});
    }
  }

  function storageSet(key, value) {
    try {
      var items = {};
      items[key] = value;
      chrome.storage.local.set(items);
    } catch (e) {
      /* storage unavailable — non-fatal */
    }
  }

  // ------------------------------------------------------------- dom helpers

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  function button(className, label, title, onClick) {
    var node = el('button', className, label);
    node.type = 'button';
    if (title) {
      node.title = title;
      // Icon-only buttons (📋, ✕, ⇄, …) would otherwise be announced as
      // emoji names — the tooltip doubles as the accessible name.
      node.setAttribute('aria-label', title);
    }
    node.addEventListener('click', onClick);
    return node;
  }

  function clearChildren(node) {
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  // ------------------------------------------------------------ json render

  var TOKEN_PATTERN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

  /** Append syntax-highlighted JSON text to `container` as DOM spans. */
  function appendHighlightedJson(container, text) {
    var fragment = document.createDocumentFragment();
    var lastIndex = 0;
    var match;
    TOKEN_PATTERN.lastIndex = 0;
    while ((match = TOKEN_PATTERN.exec(text)) !== null) {
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      var tokenText = match[0];
      var cls;
      if (match[1] !== undefined) {
        if (match[2] !== undefined) {
          cls = 'gejq-tok-key';
          tokenText = match[1];
          TOKEN_PATTERN.lastIndex = match.index + match[1].length;
        } else {
          cls = 'gejq-tok-string';
        }
      } else if (tokenText === 'true' || tokenText === 'false' || tokenText === 'null') {
        cls = 'gejq-tok-literal';
      } else {
        cls = 'gejq-tok-number';
      }
      fragment.appendChild(el('span', cls, tokenText));
      lastIndex = TOKEN_PATTERN.lastIndex;
    }
    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
    container.appendChild(fragment);
  }

  var TABLE_ROW_LIMIT = 1000;
  var TREE_CHILD_LIMIT = 200;

  /** Rows in the order the table currently shows them (sorting applied). */
  function sortedTableRows(value) {
    var shape = GEJQ.csvShape(value);
    if (shape === null || state.tableSort.column === null) {
      return value;
    }
    return GEJQ.sortRows(value, shape === 'objects' ? state.tableSort.column : null, state.tableSort.dir);
  }

  function cellText(cell) {
    if (cell === null || cell === undefined) {
      return '';
    }
    var text = typeof cell === 'object' ? JSON.stringify(cell) : String(cell);
    return text.length > 200 ? text.slice(0, 200) + '…' : text;
  }

  /** Sortable table for CSV mode; header clicks toggle the sort. */
  function renderTable(output, value) {
    var shape = GEJQ.csvShape(value);
    var columns = shape === 'objects' ? GEJQ.csvColumns(value) : ['value'];
    var rows = sortedTableRows(value);
    var scroller = el('div', 'gejq-table-scroll');
    var table = el('table', 'gejq-table');
    var head = el('thead');
    var headRow = el('tr');
    columns.forEach(function (column) {
      var sortColumn = shape === 'objects' ? column : null;
      var active = state.tableSort.column === (sortColumn === null ? 'value' : sortColumn);
      var th = el('th');
      var sortButton = button(
        'gejq-th-button' + (active ? ' gejq-th-active' : ''),
        column + (active ? (state.tableSort.dir === 1 ? ' ▲' : ' ▼') : ''),
        'Sort by ' + column,
        function () {
          var key = sortColumn === null ? 'value' : sortColumn;
          if (state.tableSort.column === key) {
            state.tableSort.dir = -state.tableSort.dir;
          } else {
            state.tableSort = { column: key, dir: 1 };
          }
          if (state.lastValue !== undefined) {
            renderResult(state.lastValue);
          }
        }
      );
      th.appendChild(sortButton);
      headRow.appendChild(th);
    });
    head.appendChild(headRow);
    table.appendChild(head);
    var body = el('tbody');
    rows.slice(0, TABLE_ROW_LIMIT).forEach(function (row) {
      var tr = el('tr');
      if (shape === 'objects') {
        columns.forEach(function (column) {
          tr.appendChild(el('td', null, cellText(row[column])));
        });
      } else {
        tr.appendChild(el('td', null, cellText(row)));
      }
      body.appendChild(tr);
    });
    table.appendChild(body);
    scroller.appendChild(table);
    if (rows.length > TABLE_ROW_LIMIT) {
      output.appendChild(
        el('div', 'gejq-notice', 'Showing the first ' + TABLE_ROW_LIMIT + ' of ' + rows.length + ' rows — Copy/Download export all of them (sorted).')
      );
    }
    output.appendChild(scroller);
  }

  /** Interactive JSON tree: clicking a property builds the path query. */
  function renderTree(output, value) {
    var language = state.settings.queryLanguage;
    var baseQuery = state.query.trim();

    function preview(val) {
      if (val === null) {
        return 'null';
      }
      if (Array.isArray(val)) {
        return '[' + val.length + ']';
      }
      if (typeof val === 'object') {
        return '{' + Object.keys(val).length + '}';
      }
      var text = typeof val === 'string' ? '"' + val + '"' : String(val);
      return text.length > 80 ? text.slice(0, 80) + '…' : text;
    }

    function wildcardized(segments) {
      return segments.map(function (segment) {
        return segment.type === 'index' ? { type: 'wildcard' } : segment;
      });
    }

    function childEntries(val) {
      if (Array.isArray(val)) {
        return val.slice(0, TREE_CHILD_LIMIT).map(function (item, index) {
          return { label: '[' + index + ']', segment: { type: 'index', value: index }, value: item };
        });
      }
      return Object.keys(val)
        .slice(0, TREE_CHILD_LIMIT)
        .map(function (key) {
          return { label: key, segment: { type: 'key', name: key }, value: val[key] };
        });
    }

    function renderChildren(container, val, segments, depth) {
      childEntries(val).forEach(function (entry) {
        container.appendChild(nodeRow(entry, segments, depth));
      });
      var total = Array.isArray(val) ? val.length : Object.keys(val).length;
      if (total > TREE_CHILD_LIMIT) {
        container.appendChild(el('div', 'gejq-tree-more', '… ' + (total - TREE_CHILD_LIMIT) + ' more (showing first ' + TREE_CHILD_LIMIT + ')'));
      }
    }

    function nodeRow(entry, parentSegments, depth) {
      var segments = parentSegments.concat([entry.segment]);
      var wrap = el('div');
      var row = el('div', 'gejq-tree-row');
      row.style.paddingLeft = depth * 14 + 'px';
      var expandable = entry.value !== null && typeof entry.value === 'object' &&
        (Array.isArray(entry.value) ? entry.value.length > 0 : Object.keys(entry.value).length > 0);
      var childrenBox = null;
      var toggle = el('span', 'gejq-tree-toggle', expandable ? '▸' : ' ');
      if (expandable) {
        toggle.addEventListener('click', function () {
          if (childrenBox === null) {
            childrenBox = el('div');
            renderChildren(childrenBox, entry.value, segments, depth + 1);
            wrap.appendChild(childrenBox);
            toggle.textContent = '▾';
          } else {
            childrenBox.style.display = childrenBox.style.display === 'none' ? '' : 'none';
            toggle.textContent = childrenBox.style.display === 'none' ? '▸' : '▾';
          }
        });
      }
      row.appendChild(toggle);
      var path = GEJQ.pathQuery(language, wildcardized(segments));
      var query = null;
      if (path !== null) {
        if (baseQuery === '') {
          query = path;
        } else if (language === 'jmespath' || language === 'jq') {
          // The tree shows the current query's result, so pipe the path onto it.
          query = baseQuery + ' | ' + path;
        }
      }
      if (query !== null) {
        row.appendChild(
          button('gejq-tree-key', entry.label, 'Use as query: ' + query, function () {
            setQuery(query);
          })
        );
      } else {
        row.appendChild(el('span', 'gejq-tree-key-plain', entry.label));
      }
      row.appendChild(el('span', 'gejq-tree-preview', preview(entry.value)));
      wrap.appendChild(row);
      return wrap;
    }

    var root = el('div', 'gejq-tree');
    if (value === null || typeof value !== 'object') {
      root.appendChild(el('div', 'gejq-empty', 'The result is a scalar — nothing to expand. Value: ' + preview(value)));
    } else {
      root.appendChild(el('div', 'gejq-tree-hint', 'Click a property to use its path as the query.'));
      renderChildren(root, value, [], 0);
    }
    output.appendChild(root);
  }

  /**
   * Render the query result: sortable table in CSV mode (when the result
   * is CSV-able), interactive tree in Tree mode, otherwise pretty JSON.
   * Returns { mode, size, sizeIsLowerBound } — size is the serialized
   * length. Serialization is capped at RENDER_LIMIT characters
   * (GEJQ.stringifyLimited), so huge auto-fetched datasets never build a
   * full multi-megabyte string on every keystroke — that froze the tab.
   * Copy/Download still serialize the full result on demand.
   */
  function renderResult(value) {
    var output = ui.resultOutput;
    clearChildren(output);
    if (value === undefined) {
      output.appendChild(el('div', 'gejq-empty', 'The query returned no result (undefined).'));
      return { mode: 'json', size: 0, sizeIsLowerBound: false };
    }
    var limited = GEJQ.stringifyLimited(value, RENDER_LIMIT);
    var text = typeof limited.text === 'string' ? limited.text : String(value);
    var size = limited.length;
    if (state.format === 'csv' && GEJQ.csvEligible(value)) {
      renderTable(output, value);
      return { mode: 'csv', size: size, sizeIsLowerBound: limited.truncated };
    }
    if (state.format === 'tree') {
      renderTree(output, value);
      return { mode: 'tree', size: size, sizeIsLowerBound: limited.truncated };
    }
    if (limited.truncated) {
      output.appendChild(
        el(
          'div',
          'gejq-notice',
          'Result is large (over ' + GEJQ.formatBytes(RENDER_LIMIT) + ' of JSON). Showing the first part — use Copy or Download for the full result.'
        )
      );
      output.appendChild(el('pre', 'gejq-json', text + '\n…'));
      return { mode: 'json', size: size, sizeIsLowerBound: true };
    }
    var pre = el('pre', 'gejq-json');
    if (text.length > HIGHLIGHT_LIMIT) {
      pre.textContent = text;
    } else {
      appendHighlightedJson(pre, text);
    }
    output.appendChild(pre);
    return { mode: 'json', size: size, sizeIsLowerBound: false };
  }

  // ------------------------------------------------------------ query logic

  /** Responses shown in the panel (background ones only when enabled). */
  function visibleResponses() {
    if (state.settings.showBackgroundRequests) {
      return state.responses;
    }
    return state.responses.filter(function (entry) {
      return !entry.background;
    });
  }

  /** The newest "real" (non-manual) response — what "live" follows, so a
   *  pinned-result snapshot sitting at the top of the list never hijacks it. */
  function newestLiveResponse(list) {
    for (var i = 0; i < list.length; i++) {
      if (!list[i].manual) {
        return list[i];
      }
    }
    return list[0];
  }

  function selectedResponse() {
    var list = visibleResponses();
    if (list.length === 0) {
      return null;
    }
    // selectedId is the source of truth for what's shown; fall back to the
    // newest live response when nothing is selected or the selection is gone.
    if (state.selectedId !== null) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === state.selectedId) {
          return list[i];
        }
      }
    }
    return newestLiveResponse(list);
  }

  /** Evaluate `query` against `json` in the selected query language. */
  function executeQuery(json, query) {
    if (state.settings.queryLanguage === 'jsonpath') {
      return JSONPath.JSONPath({ path: query, json: json, wrap: true });
    }
    if (state.settings.queryLanguage === 'jq') {
      var jq = JQTS.default || JQTS;
      var outputs = jq.compile(query).evaluate(json);
      // jq produces a stream of outputs; unwrap the common single-output case.
      return outputs.length === 1 ? outputs[0] : outputs;
    }
    return jmespath.search(json, query);
  }

  function currentResult() {
    var response = selectedResponse();
    if (!response || response.tooLarge) {
      return { value: undefined, error: null, empty: true };
    }
    var query = state.query.trim();
    if (query === '') {
      return { value: response.json, error: null };
    }
    try {
      return { value: executeQuery(response.json, query), error: null };
    } catch (e) {
      var label = LANGUAGES[state.settings.queryLanguage].label;
      return { value: undefined, error: label + ': ' + (e && e.message ? e.message : String(e)) };
    }
  }

  /** Cache key for runQuery's evaluation: what it was computed against. */
  function outcomeKey() {
    var response = selectedResponse();
    return (response ? response.id : '') + '|' + state.settings.queryLanguage + '|' + state.query;
  }

  /**
   * The last runQuery evaluation when still current, else a fresh one —
   * so Copy/Download/recordQuery never re-run the query on big datasets
   * just to read the value runQuery already computed.
   */
  function currentOutcome() {
    if (state.lastOutcome && state.lastOutcomeKey === outcomeKey()) {
      return state.lastOutcome;
    }
    return currentResult();
  }

  /**
   * Fill the response row: a live/pinned badge plus the full request
   * line (timestamp · METHOD url → status) as selectable text — unlike
   * the truncated labels inside the compact <select>.
   */
  function updateResponseInfo(response) {
    if (!response) {
      ui.liveBadge.style.display = 'none';
      ui.responseText.value = '';
      return;
    }
    // "Live" only when the shown response is the newest real (non-manual)
    // one — a pasted/pinned snapshot or an older selection reads "pinned".
    var newest = newestLiveResponse(visibleResponses());
    var live = !response.manual && !!newest && newest.id === response.id;
    ui.liveBadge.style.display = '';
    ui.liveBadge.textContent = live ? '● live' : 'pinned';
    ui.liveBadge.classList.toggle('gejq-live', live);
    ui.liveBadge.title = live
      ? 'Following the latest response: the query re-runs automatically whenever a new Graph query executes'
      : 'Pinned to this response — pick the newest entry in the dropdown to follow new responses again';
    var status = response.manual ? (response.method === 'PASTE' ? 'pasted' : '') : '→ ' + response.status;
    if (response.pages) {
      status += ' · ' + response.pages + ' pages' + (response.partial ? ' so far' : response.truncated ? ', incomplete' : '');
    }
    ui.responseText.value =
      GEJQ.formatTimestamp(response.timestamp) + ' · ' + response.method + ' ' + response.url + ' ' + status +
      (response.background ? ' · ⚙ background' : '');
    ui.responseText.title = ui.responseText.value;
  }

  function setWarning(text) {
    ui.warning.textContent = text;
  }

  /**
   * Honest description of why an auto-fetched dataset is incomplete:
   * a user stop and a page error are named as such — never blamed on a
   * configured limit (limits pause the chain now; they don't end it).
   */
  function truncationWarning(response) {
    var summary = response.pages + ' pages (' + GEJQ.formatBytes(response.size) + ') were fetched — this dataset is incomplete.';
    if (response.stopReason === 'error') {
      return '⚠ Auto-fetch hit an error: only ' + summary;
    }
    return '⚠ Auto-fetch was stopped: only ' + summary;
  }

  function runQuery() {
    var response = selectedResponse();
    updateResponseInfo(response);
    syncTheme();

    if (!response) {
      state.lastOutcome = null;
      ui.error.textContent = '';
      setWarning('');
      ui.meta.textContent = '';
      ui.metaRight.textContent = '';
      clearChildren(ui.resultOutput);
      ui.resultOutput.appendChild(
        el(
          'div',
          'gejq-empty',
          'Run a query in Graph Explorer — the response will appear here, ready for ' +
            LANGUAGES[state.settings.queryLanguage].label +
            ' querying. Or use “Paste JSON” to bring your own data.'
        )
      );
      updateExportButtons();
      renderGraphEquivalent();
      return;
    }

    if (response.tooLarge) {
      state.lastOutcome = null;
      ui.error.textContent = '';
      setWarning('');
      ui.meta.textContent = '';
      ui.metaRight.textContent = '';
      clearChildren(ui.resultOutput);
      ui.resultOutput.appendChild(
        el(
          'div',
          'gejq-notice',
          'This response (' + GEJQ.formatBytes(response.size) + ') is too large to capture. Try narrowing the Graph query with $select or $top.'
        )
      );
      updateExportButtons();
      renderGraphEquivalent();
      return;
    }

    setWarning(response.truncated ? truncationWarning(response) : '');

    // Suggestions depend on the response and language, not on the query —
    // refresh them even when the current query errors (e.g. right after
    // a language switch left an incompatible query in the box).
    renderSuggestions(response.json);

    var outcome = currentResult();
    state.lastOutcome = outcome; // reused by recordQuery/exportPayload — no re-evaluation
    state.lastOutcomeKey = outcomeKey();
    if (outcome.error) {
      ui.error.textContent = outcome.error;
      updateExportButtons(outcome);
      renderGraphEquivalent();
      return; // keep previous result visible while the user types
    }
    ui.error.textContent = '';
    state.lastValue = outcome.value;
    var renderKey = response.id + '|' + state.query;
    if (renderKey !== state.lastRenderKey) {
      state.lastRenderKey = renderKey;
      state.tableSort = { column: null, dir: 1 }; // new data → reset sorting
    }
    if (state.diff.active) {
      renderDiffView(response, outcome.value);
      updateExportButtons(outcome);
      renderGraphEquivalent();
      return;
    }
    var rendered = renderResult(outcome.value);
    // Single readout on the right: type · count · size (· view). The count
    // (items/keys/chars) that used to sit on the left is folded in here, so
    // there is no redundant second count.
    ui.meta.textContent = '';
    ui.metaRight.textContent =
      GEJQ.describeResult(outcome.value) +
      (rendered.size > 0 ? ' · ' + (rendered.sizeIsLowerBound ? '≥ ' : '') + GEJQ.formatBytes(rendered.size) : '') +
      (rendered.mode === 'csv' ? ' · table view' : rendered.mode === 'tree' ? ' · tree view' : '') +
      (response.pages >= 2
        ? ' · auto-fetched · ' + response.pages + ' pages' + (response.partial ? ' so far' : response.truncated ? ' (incomplete)' : '')
        : '');
    updateExportButtons(outcome);
    renderGraphEquivalent();
  }

  /** Compare mode: the current query applied to baseline vs selected. */
  function renderDiffView(response, currentValue) {
    var output = ui.resultOutput;
    clearChildren(output);
    var baseline = null;
    var list = visibleResponses();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === state.diff.baseId) {
        baseline = list[i];
      }
    }
    if (!baseline || baseline.id === response.id) {
      ui.meta.textContent = '';
      ui.metaRight.textContent = 'Compare: pick a baseline response below';
      state.diffText = '';
      output.appendChild(el('div', 'gejq-empty', 'Pick a different response in the "vs" dropdown to compare against.'));
      return;
    }
    var baseValue;
    try {
      baseValue = state.query.trim() === '' ? baseline.json : executeQuery(baseline.json, state.query.trim());
    } catch (e) {
      output.appendChild(el('div', 'gejq-notice', 'The query fails on the baseline response: ' + (e.message || e)));
      state.diffText = '';
      return;
    }
    var diffs = GEJQ.diffJson(baseValue, currentValue, 500);
    ui.meta.textContent = '';
    ui.metaRight.textContent = diffs.length + ' difference(s) vs baseline';
    var lines = [];
    if (diffs.length === 0) {
      output.appendChild(el('div', 'gejq-empty', 'No differences between the two results.'));
    }
    diffs.forEach(function (diff) {
      var row = el('div', 'gejq-diff-row gejq-diff-' + diff.kind);
      var marker = diff.kind === 'added' ? '+' : diff.kind === 'removed' ? '−' : '~';
      row.appendChild(el('span', 'gejq-diff-marker', marker));
      row.appendChild(el('span', 'gejq-diff-path', diff.path));
      var beforeText = diff.before === undefined ? '' : JSON.stringify(diff.before);
      var afterText = diff.after === undefined ? '' : JSON.stringify(diff.after);
      var detail =
        diff.kind === 'added' ? afterText : diff.kind === 'removed' ? beforeText : beforeText + ' → ' + afterText;
      row.appendChild(el('span', 'gejq-diff-detail', detail.length > 160 ? detail.slice(0, 160) + '…' : detail));
      output.appendChild(row);
      lines.push(marker + ' ' + diff.path + ': ' + detail);
    });
    state.diffText = lines.join('\n');
  }

  function scheduleRun() {
    if (runTimer) {
      clearTimeout(runTimer);
    }
    runTimer = setTimeout(runQuery, 180);
  }

  function scheduleQueryStore() {
    if (queryStoreTimer) {
      clearTimeout(queryStoreTimer);
    }
    queryStoreTimer = setTimeout(function () {
      queryStoreTimer = null;
      storageSet(STORAGE_KEY_QUERY, state.query);
    }, 500);
  }

  // ------------------------------------------------------------- exporting

  /** The current result in the selected export format, or null. */
  function exportPayload() {
    if (state.diff.active) {
      if (state.diffText === '') {
        return null;
      }
      return { text: state.diffText, filename: GEJQ.exportFilename('', 'txt'), mime: 'text/plain' };
    }
    var outcome = currentOutcome();
    if (outcome.error || outcome.value === undefined) {
      return null;
    }
    var response = selectedResponse();
    var sourceUrl = response ? response.url : '';
    if (state.format === 'csv') {
      // Export what the table shows — the applied sorting included — in the
      // delimiter the copy-format dropdown selects (CSV or TSV).
      var rows = sortedTableRows(outcome.value);
      var tsv = state.copyFormat === 'tsv';
      var text = tsv ? GEJQ.toTsv(rows) : GEJQ.toCsv(rows);
      if (text === null) {
        return null;
      }
      return {
        text: text,
        filename: GEJQ.exportFilename(sourceUrl, tsv ? 'tsv' : 'csv'),
        mime: tsv ? 'text/tab-separated-values' : 'text/csv',
        bom: true // UTF-8 BOM so Excel reads accents in both CSV and TSV
      };
    }
    return {
      text: JSON.stringify(outcome.value, null, 2),
      filename: GEJQ.exportFilename(sourceUrl, 'json'),
      mime: 'application/json'
    };
  }

  /**
   * Refresh the export controls. Pass the outcome already computed by
   * the caller to avoid re-evaluating the query; omitted only from
   * callers that run outside a query evaluation (init, format switch).
   */
  function updateExportButtons(outcome) {
    if (outcome === undefined) {
      outcome = currentOutcome();
    }
    var hasResult = !outcome.error && outcome.value !== undefined;
    var csvOk = hasResult && GEJQ.csvEligible(outcome.value);
    var diffing = state.diff.active;
    ui.csvToggle.disabled = diffing || !csvOk;
    ui.csvToggle.title = hasResult && !csvOk
      ? 'This result cannot be shown as a table / CSV (needs an array of objects or scalar values)'
      : 'Table view / export as CSV';
    ui.jsonToggle.disabled = diffing;
    ui.treeToggle.disabled = diffing || !hasResult;
    ui.jsonToggle.classList.toggle('gejq-seg-active', !diffing && state.format === 'json');
    ui.csvToggle.classList.toggle('gejq-seg-active', !diffing && state.format === 'csv');
    ui.treeToggle.classList.toggle('gejq-seg-active', !diffing && state.format === 'tree');
    ui.jsonToggle.setAttribute('aria-pressed', state.format === 'json' ? 'true' : 'false');
    ui.csvToggle.setAttribute('aria-pressed', state.format === 'csv' ? 'true' : 'false');
    ui.treeToggle.setAttribute('aria-pressed', state.format === 'tree' ? 'true' : 'false');
    var exportable = diffing ? state.diffText !== '' : hasResult && (state.format !== 'csv' || csvOk);
    ui.copyButton.disabled = !exportable;
    ui.downloadButton.disabled = !exportable;
    // The CSV/TSV copy-format dropdown only applies in CSV (table) mode.
    var showCopyFormat = !diffing && state.format === 'csv' && csvOk;
    ui.copyFormatSelect.style.display = showCopyFormat ? '' : 'none';
  }

  function setFormat(format) {
    state.format = format;
    storageSet(STORAGE_KEY_FORMAT, format);
    runQuery(); // re-render: the output view follows the selected format
  }

  // -------------------------------------------------------------- settings

  function saveSettings() {
    storageSet(STORAGE_KEY_SETTINGS, state.settings);
  }

  /** Reflect the auto-fetch setting on the panel's ⟳ toggle chip. */
  function applyAutoFetchToggle() {
    if (!ui || !ui.autoFetchToggle) {
      return;
    }
    var on = state.settings.autoFetchNextLink;
    ui.autoFetchToggle.classList.toggle('gejq-tag-active', on);
    ui.autoFetchToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
    ui.autoFetchToggle.title =
      'Auto-fetch all pages (@odata.nextLink): ' + (on ? 'on' : 'off') + ' — click to turn ' + (on ? 'off' : 'on');
    ui.autoFetchToggle.setAttribute('aria-label', ui.autoFetchToggle.title);
  }

  /** Forward settings the MAIN-world interceptor needs via postMessage. */
  function pushSettingsToPage() {
    try {
      window.postMessage(
        {
          source: SETTINGS_SOURCE,
          settings: {
            autoFetchNextLink: state.settings.autoFetchNextLink,
            autoFetchMaxPages: state.settings.autoFetchMaxPages,
            autoFetchMaxChars: state.settings.autoFetchMaxMb * 1024 * 1024
          }
        },
        window.location.origin
      );
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * Follow Graph Explorer's own theme switcher (persisted by GE in
   * localStorage as CURRENT_THEME) instead of only the OS preference,
   * so the split view never shows mixed light/dark halves.
   */
  function syncTheme() {
    var theme = '';
    try {
      theme = (localStorage.getItem('CURRENT_THEME') || '').replace(/"/g, '').toLowerCase();
    } catch (e) {
      /* storage blocked — stay on the OS preference */
    }
    ui.host.classList.toggle('gejq-theme-dark', theme === 'dark' || theme === 'high-contrast');
    ui.host.classList.toggle('gejq-theme-light', theme === 'light');
  }

  /** Re-apply everything that depends on the selected query language. */
  function applyLanguage() {
    var language = LANGUAGES[state.settings.queryLanguage];
    closeAutocomplete();
    ui.titleLabel.textContent = 'JSON Query (' + language.label + ')';
    ui.queryEditor.setPlaceholder(language.placeholder);
    ui.queryEditor.setLanguage(state.settings.queryLanguage);
    if (ui.languageSelect.value !== state.settings.queryLanguage) {
      ui.languageSelect.value = state.settings.queryLanguage;
    }
    renderSuggestionHelp();
    runQuery();
  }

  /**
   * Best-effort translation of the current query into the new language
   * (simple path expressions only). When the query can't be converted it
   * is left as-is: the error line and refreshed suggestions guide the
   * user instead.
   */
  function convertCurrentQuery(fromLanguage, toLanguage) {
    var query = state.query.trim();
    if (query === '') {
      return;
    }
    var converted = GEJQ.convertQuery(query, fromLanguage, toLanguage);
    if (converted.ok && converted.query !== query) {
      state.query = converted.query;
      ui.queryEditor.setValue(converted.query);
      storageSet(STORAGE_KEY_QUERY, converted.query);
    }
  }

  /** Switch language (from the panel selector), converting the query. */
  function switchLanguage(newLanguage) {
    var oldLanguage = state.settings.queryLanguage;
    if (!LANGUAGES[newLanguage] || newLanguage === oldLanguage) {
      return;
    }
    state.settings.queryLanguage = newLanguage;
    saveSettings();
    pushSettingsToPage();
    convertCurrentQuery(oldLanguage, newLanguage);
    applyLanguage();
  }

  // ----------------------------------------------------------- auto sign-in

  /** True when MSAL (Graph Explorer's auth library) has a cached account. */
  function msalSignedIn() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (!key) {
          continue;
        }
        var lower = key.toLowerCase();
        if (lower.indexOf('msal') !== -1 && lower.indexOf('account.keys') !== -1) {
          var parsed = GEJQ.safeJsonParse(localStorage.getItem(key) || '');
          if (parsed.ok && Array.isArray(parsed.value) && parsed.value.length > 0) {
            return true;
          }
        }
        if (lower.indexOf('login.windows.net') !== -1) {
          return true;
        }
      }
    } catch (e) {
      /* storage blocked — assume signed out */
    }
    return false;
  }

  /**
   * If enabled and the user is signed out, click Graph Explorer's
   * profile view (the avatar button in the top bar) once to start the
   * sign-in flow. Attempted at most once per tab session; browsers may
   * still ask the user to allow the sign-in popup.
   */
  function maybeAutoSignIn() {
    if (!state.settings.autoSignIn) {
      return;
    }
    try {
      if (sessionStorage.getItem(AUTO_SIGNIN_GUARD)) {
        return;
      }
    } catch (e) {
      /* ignore */
    }
    if (msalSignedIn()) {
      return;
    }
    var deadline = Date.now() + 20000;
    var timer = setInterval(function () {
      if (Date.now() > deadline || msalSignedIn()) {
        clearInterval(timer);
        return;
      }
      for (var i = 0; i < SIGN_IN_SELECTORS.length; i++) {
        var signInButton = document.querySelector(SIGN_IN_SELECTORS[i]);
        if (signInButton) {
          clearInterval(timer);
          try {
            sessionStorage.setItem(AUTO_SIGNIN_GUARD, '1');
          } catch (e) {
            /* ignore */
          }
          signInButton.click();
          return;
        }
      }
    }, 500);
  }

  // --------------------------------------------------------------- history

  function optionLabel(entry) {
    var status = entry.manual ? 'pasted' : entry.status;
    if (entry.pages) {
      status += ' · ' + entry.pages + ' pages' + (entry.partial ? ' so far' : entry.truncated ? ', incomplete' : '');
    }
    return (
      (entry.background ? '⚙ ' : '') +
      GEJQ.formatTimestamp(entry.timestamp) +
      ' · ' + entry.method + ' ' + GEJQ.summarizeUrl(entry.url, 60) + ' (' + status + ')'
    );
  }

  /** Baseline options for compare mode: everything except the selection. */
  function refreshDiffSelect() {
    var select = ui.diffSelect;
    var current = selectedResponse();
    clearChildren(select);
    var list = visibleResponses().filter(function (entry) {
      return !current || entry.id !== current.id;
    });
    list.forEach(function (entry) {
      var option = el('option', null, optionLabel(entry));
      option.value = entry.id;
      select.appendChild(option);
    });
    select.disabled = list.length === 0;
    if (list.length === 0) {
      state.diff.baseId = null;
      return;
    }
    // Default baseline: the previous capture of the same URL, if any.
    var chosen = null;
    if (state.diff.baseId) {
      chosen = list.filter(function (entry) {
        return entry.id === state.diff.baseId;
      })[0];
    }
    if (!chosen && current) {
      chosen = list.filter(function (entry) {
        return entry.url === current.url;
      })[0];
    }
    if (!chosen) {
      chosen = list[0];
    }
    state.diff.baseId = chosen.id;
    select.value = chosen.id;
  }

  function refreshHistorySelect() {
    var select = ui.historySelect;
    var list = visibleResponses();
    clearChildren(select);
    if (list.length === 0) {
      var placeholder = el('option', null, 'Waiting for Graph responses…');
      placeholder.value = '';
      select.appendChild(placeholder);
      select.disabled = true;
    } else {
      select.disabled = false;
      list.forEach(function (entry) {
        var option = el('option', null, optionLabel(entry));
        option.value = entry.id;
        select.appendChild(option);
      });
      var selected = selectedResponse();
      select.value = selected ? selected.id : list[0].id;
    }
    if (state.diff.active) {
      refreshDiffSelect();
    }
  }

  /** Feed the current query result back in as a new queryable source. */
  function pinCurrentResult() {
    var outcome = currentOutcome();
    if (outcome.error || outcome.value === undefined) {
      return;
    }
    manualCounter += 1;
    var label = state.query.trim() === '' ? '@' : state.query.trim();
    var id = 'result-' + Date.now() + '-' + manualCounter;
    // Select the snapshot so it's shown now (badge reads "pinned" because
    // it's a manual entry). followLatest stays on so running a new Graph
    // query afterwards resumes the live view; the pin remains in the list.
    addResponse({
      id: id,
      method: 'RESULT',
      url: 'pinned result #' + manualCounter + ' of ' + (label.length > 50 ? label.slice(0, 50) + '…' : label),
      status: 0,
      manual: true,
      timestamp: Date.now(),
      json: outcome.value,
      size: GEJQ.stringifyLimited(outcome.value, RENDER_LIMIT).length
    });
    state.selectedId = id;
    refreshHistorySelect();
    setQuery('');
  }

  function addResponse(entry) {
    // Auto-fetch chains keep a stable entry id and post updates as pages
    // accumulate — replace the existing entry in place instead of adding.
    var replaced = false;
    for (var i = 0; i < state.responses.length; i++) {
      if (state.responses[i].id === entry.id) {
        state.responses[i] = entry;
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      state.responses.unshift(entry);
      // Manual sources (pinned results, pasted JSON) are counted apart so
      // a stream of new responses can never push them out.
      state.responses = GEJQ.trimResponses(state.responses, MAX_HISTORY);
    }
    var visible = !entry.background || state.settings.showBackgroundRequests;
    // Keep the selection on the newest live response while following, but
    // never auto-jump onto a manual pinned-result snapshot.
    if (state.followLatest && visible && !entry.manual) {
      state.selectedId = entry.id;
    }
    if (ui) {
      refreshHistorySelect();
      updateBadge();
      if (visible) {
        if (!replaced) {
          pulseFab();
        }
        // Re-run for updates to the shown entry too (stepping through
        // pages while pinned to the growing dataset).
        if (state.open && (state.followLatest || state.selectedId === entry.id)) {
          runQuery();
        }
      }
    }
  }

  function updateBadge() {
    var count = visibleResponses().length;
    ui.fabBadge.textContent = count > 99 ? '99+' : String(count);
    ui.fabBadge.style.display = count > 0 ? '' : 'none';
  }

  function pulseFab() {
    ui.fab.classList.remove('gejq-pulse');
    // Force a reflow so removing/adding the class restarts the animation.
    void ui.fab.offsetWidth;
    ui.fab.classList.add('gejq-pulse');
  }

  // ------------------------------------------------------------ suggestions

  function renderSuggestions(json) {
    // Suggestions depend only on (response, language) — skip the rebuild
    // when neither changed (runQuery calls this on every keystroke).
    if (suggestionsCache.json === json && suggestionsCache.key === state.settings.queryLanguage) {
      return;
    }
    suggestionsCache.json = json;
    suggestionsCache.key = state.settings.queryLanguage;
    var container = ui.suggestions;
    clearChildren(container);
    // The section stays visible for the documentation reference even when
    // there are no data-driven suggestions (e.g. a scalar result).
    var queries = GEJQ.suggestQueries(json, state.settings.queryLanguage);
    if (queries.length === 0) {
      return;
    }
    var chipRow = el('div', 'gejq-chip-row');
    queries.slice(0, 6).forEach(function (query) {
      chipRow.appendChild(
        button('gejq-chip', query, 'Use this query', function () {
          setQuery(query);
        })
      );
    });
    container.appendChild(chipRow);
  }

  function setQuery(query) {
    state.query = query;
    ui.queryEditor.setValue(query);
    storageSet(STORAGE_KEY_QUERY, query);
    runQuery();
    recordQuery();
    ui.queryEditor.focus();
  }

  // ----------------------------------------- Graph (OData) equivalent view

  /** `$filter=…&$select=…` display text when there is no URL to merge into. */
  function graphParamsText(params) {
    var pairs = [];
    if (params.filter) {
      pairs.push('$filter=' + params.filter);
    }
    if (params.select.length > 0) {
      pairs.push('$select=' + params.select.join(','));
    }
    if (params.orderby) {
      pairs.push('$orderby=' + params.orderby);
    }
    if (params.skip !== null) {
      pairs.push('$skip=' + params.skip);
    }
    if (params.top !== null) {
      pairs.push('$top=' + params.top);
    }
    if (params.count) {
      pairs.push('$count=true');
    }
    return pairs.join('&');
  }

  /**
   * Refresh the "Graph equivalent" toggle + panel: translate the current
   * query into OData query options (GEJQ.toGraphQuery), merge them into
   * the selected response's request URL, and show what runs server-side
   * vs. the highlighted residual that must stay client-side.
   */
  function renderGraphEquivalent() {
    if (!ui || !ui.graphEqToggle) {
      return;
    }
    var translation = GEJQ.toGraphQuery(state.settings.queryLanguage, state.query.trim());
    ui.graphEqToggle.disabled = !translation.ok && !state.graphEqOpen;
    ui.graphEqToggle.title = translation.ok
      ? 'Show the Microsoft Graph (OData) equivalent of this query — the part that can run server-side'
      : translation.reason;
    ui.graphEqToggle.setAttribute('aria-label', ui.graphEqToggle.title);
    if (!state.graphEqOpen) {
      return;
    }
    var box = ui.graphEqRow;
    clearChildren(box);
    if (!translation.ok) {
      box.appendChild(el('div', 'gejq-grapheq-reason', translation.reason));
      return;
    }
    var response = selectedResponse();
    var urlInfo = response ? GEJQ.graphQueryUrl(response.url, translation.params) : null;
    var serverLine = urlInfo ? 'GET ' + urlInfo.url : graphParamsText(translation.params);

    var serverRow = el('div', 'gejq-grapheq-line');
    serverRow.appendChild(el('span', 'gejq-grapheq-label', 'Server ▸'));
    var serverText = el('input', 'gejq-grapheq-text');
    serverText.type = 'text';
    serverText.readOnly = true;
    serverText.value = serverLine;
    serverText.title = serverLine;
    serverRow.appendChild(serverText);
    serverRow.appendChild(
      button('gejq-icon-mini', '📋', 'Copy the Graph request', function (event) {
        copyText(serverLine, event.currentTarget, '✓');
      })
    );
    if (urlInfo) {
      serverRow.appendChild(
        button('gejq-chip gejq-load', 'Load ↗', 'Put this request into Graph Explorer’s URI field — in place, no reload', function () {
          populateGraphExplorer('GET', urlInfo.url, [], '');
        })
      );
    }
    box.appendChild(serverRow);

    var clientRow = el('div', 'gejq-grapheq-line');
    clientRow.appendChild(el('span', 'gejq-grapheq-label', 'Client ▸'));
    if (translation.residual) {
      clientRow.appendChild(
        button(
          'gejq-chip gejq-grapheq-residual',
          translation.residual,
          'This part has no server-side equivalent — click to use it as the query against the server request’s response',
          function () {
            setQuery(translation.residual);
          }
        )
      );
      clientRow.appendChild(
        el(
          'span',
          'gejq-grapheq-hint',
          translation.notes.length > 0
            ? 'the highlighted parts must stay client-side'
            : 'run this here against the new response for the same result'
        )
      );
    } else {
      clientRow.appendChild(el('span', 'gejq-grapheq-hint', 'nothing left to do client-side'));
    }
    box.appendChild(clientRow);

    translation.notes
      .concat(urlInfo ? urlInfo.notes : [])
      .forEach(function (note) {
        box.appendChild(el('div', 'gejq-grapheq-note', '• ' + note));
      });
    if (translation.advanced) {
      box.appendChild(
        el(
          'div',
          'gejq-grapheq-note',
          '• needs ConsistencyLevel: eventual + $count=true — the Advanced queries setting adds these automatically'
        )
      );
    }
  }

  // ------------------------------------------------- auto-fetch status row

  /** Send a control action to the MAIN-world auto-fetch controller. */
  function autoFetchControl(action) {
    try {
      window.postMessage({ source: 'gejq-autofetch-control', action: action }, window.location.origin);
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * Auto-fetch progress on the meta row (same line as the result
   * metrics): a pause button leads while pages stream in; paused chains
   * offer Resume / one-page Step / Stop — including past the configured
   * limits, which only pause the chain (each Resume grants a new budget).
   */
  function renderFetchStatus() {
    if (!ui) {
      return;
    }
    var box = ui.fetchStatus;
    clearChildren(box);
    if (!fetchProgress || fetchProgress.state === 'done') {
      box.style.display = 'none';
      return;
    }
    box.style.display = '';
    var metrics =
      fetchProgress.pages + ' pages · ' + fetchProgress.items + ' items · ' + GEJQ.formatBytes(fetchProgress.size);
    if (fetchProgress.state === 'running') {
      box.appendChild(
        button('gejq-fetch-btn', '⏸', 'Pause auto-fetch after the page currently loading', function () {
          autoFetchControl('pause');
        })
      );
      box.appendChild(el('span', 'gejq-fetch-text', 'Auto-fetching… ' + metrics));
      box.appendChild(
        button('gejq-link-button', 'Stop', 'Stop and keep what was fetched so far', function () {
          autoFetchControl('stop');
        })
      );
    } else {
      box.appendChild(
        button('gejq-fetch-btn', '▶', 'Resume auto-fetching the remaining pages', function () {
          autoFetchControl('resume');
        })
      );
      box.appendChild(
        button('gejq-fetch-btn', '+1', 'Fetch one more page, then pause again', function () {
          autoFetchControl('step');
        })
      );
      box.appendChild(
        button('gejq-fetch-btn', '■', 'Stop and keep what was fetched so far', function () {
          autoFetchControl('stop');
        })
      );
      var reason =
        fetchProgress.reason === 'page-limit'
          ? ' — page limit reached; Resume or +1 continue past it'
          : fetchProgress.reason === 'size-limit'
            ? ' — size limit reached; Resume or +1 continue past it'
            : '';
      box.appendChild(el('span', 'gejq-fetch-text', 'Paused at ' + metrics + reason));
    }
  }

  // ------------------------------------------------ populate Graph Explorer

  /** Graph Explorer's URI field (localized aria-label + structural fallback). */
  function findEditorInput() {
    return (
      document.querySelector('input[aria-label="Query sample input" i]') ||
      document.querySelector('#request-area input[type="text"]')
    );
  }

  /**
   * Track when the user deliberately runs a query — clicking Graph
   * Explorer's Run button (or anything in the request bar) or pressing
   * Enter in the URI field. Used as a signal to tell user-run queries
   * apart from Graph Explorer's own background requests.
   */
  function trackRunInteractions() {
    document.addEventListener(
      'click',
      function (event) {
        var node = event.target && event.target.closest ? event.target.closest('button') : null;
        if (!node) {
          return;
        }
        var label = (node.getAttribute('aria-label') || node.textContent || '').toLowerCase();
        if (label.indexOf('run query') !== -1 || node.closest('#request-area')) {
          lastRunInteraction = Date.now();
        }
      },
      true
    );
    document.addEventListener(
      'keydown',
      function (event) {
        if (event.key === 'Enter' && event.target === findEditorInput()) {
          lastRunInteraction = Date.now();
        }
      },
      true
    );
    // Apply visible advanced-query help while the user types in the URI
    // field (debounced), and again when the field loses focus (which
    // also covers a click on Run — that blurs the field first).
    var assistTimer = null;
    document.addEventListener(
      'input',
      function (event) {
        if (event.target !== findEditorInput()) {
          return;
        }
        if (assistTimer) {
          clearTimeout(assistTimer);
        }
        assistTimer = setTimeout(function () {
          maybeAssistAdvancedQuery(false); // typing: $count only, no focus steal
        }, 400);
      },
      true
    );
    document.addEventListener(
      'blur',
      function (event) {
        if (event.target === findEditorInput()) {
          maybeAssistAdvancedQuery(true); // leaving the field: safe to add headers
        }
      },
      true
    );
  }

  // ------------------------------------------------------- autocomplete

  function closeAutocomplete() {
    autocomplete.open = false;
    autocomplete.result = null;
    ui.autocompleteList.style.display = 'none';
  }

  /** Refresh the completion dropdown from the text before the cursor. */
  function updateAutocomplete() {
    var editor = ui.queryEditor;
    var caret = editor.getCaret();
    if (caret === null) {
      closeAutocomplete();
      return;
    }
    var response = selectedResponse();
    var result = GEJQ.queryCompletions(
      state.settings.queryLanguage,
      editor.getValue().slice(0, caret),
      response && !response.tooLarge ? response.json : undefined
    );
    if (!result) {
      closeAutocomplete();
      return;
    }
    autocomplete.open = true;
    autocomplete.result = result;
    autocomplete.activeIndex = 0;
    renderAutocomplete();
  }

  function renderAutocomplete() {
    var list = ui.autocompleteList;
    clearChildren(list);
    autocomplete.result.items.forEach(function (item, index) {
      var row = el('div', 'gejq-ac-item' + (index === autocomplete.activeIndex ? ' gejq-ac-active' : ''));
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', index === autocomplete.activeIndex ? 'true' : 'false');
      row.appendChild(el('span', 'gejq-ac-label', item.label));
      if (item.detail) {
        row.appendChild(el('span', 'gejq-ac-detail', item.detail));
      }
      row.addEventListener('mousedown', function (event) {
        event.preventDefault(); // keep focus in the query input
        acceptCompletion(item);
      });
      list.appendChild(row);
    });
    list.style.display = '';
    var active = list.children[autocomplete.activeIndex];
    if (active && active.scrollIntoView) {
      active.scrollIntoView({ block: 'nearest' });
    }
  }

  function moveAutocomplete(delta) {
    var count = autocomplete.result.items.length;
    autocomplete.activeIndex = (autocomplete.activeIndex + delta + count) % count;
    renderAutocomplete();
  }

  function acceptCompletion(item) {
    var editor = ui.queryEditor;
    var caret = editor.getCaret();
    if (caret === null) {
      closeAutocomplete();
      return;
    }
    editor.replaceRange(autocomplete.result.replaceFrom, caret, item.insert);
    state.query = editor.getValue();
    storageSet(STORAGE_KEY_QUERY, state.query);
    closeAutocomplete();
    scheduleRun();
    editor.focus();
  }

  // ------------------------------------------------ advanced query assist

  var HEADER_ADDED_GUARD_PREFIX = 'gejq.headerAdded.';
  // Names whose row is being added right now. The session guard is only set
  // *after* an add is verified, so without this lock two overlapping assist
  // runs (e.g. startup + blur) could each add ConsistencyLevel before either
  // marked it done — producing duplicate rows.
  var headersInFlight = {};

  /** Poll `condition` every 150ms (up to `tries`); success → onSuccess(result), else onFail(). */
  function waitForCondition(condition, tries, onSuccess, onFail) {
    var result = null;
    try {
      result = condition();
    } catch (e) {
      result = null;
    }
    if (result) {
      onSuccess(result);
    } else if (tries > 0) {
      setTimeout(function () {
        waitForCondition(condition, tries - 1, onSuccess, onFail);
      }, 150);
    } else if (onFail) {
      onFail();
    }
  }

  /**
   * On opening Graph Explorer, add the standing headers — ConsistencyLevel
   * and Content-Type — through its Request-headers view, independent of
   * what's in the URI. Waits for the app's tab bar to render first.
   */
  function scheduleStartupHeaders() {
    if (!state.settings.advancedQuery) {
      return;
    }
    waitForCondition(
      findHeadersTab,
      100, // GE's React app can take a while to boot
      function () {
        ensureHeaderRows([
          { name: 'ConsistencyLevel', value: 'eventual' },
          { name: 'Content-Type', value: 'application/json' }
        ]);
      },
      null
    );
  }

  /**
   * Insert `$count=true&` directly after the `?` of the URI field. The
   * insertion happens *before* the caret (which sits at the end while
   * the user types `$orderby=…`), so the caret is shifted by the
   * inserted length and typing continues seamlessly.
   */
  function insertCountIntoEditor(input) {
    var value = input.value;
    var caret = input.selectionStart;
    var questionMark = value.indexOf('?');
    var next;
    var newCaret = caret;
    if (questionMark === -1) {
      next = value + '?$count=true';
    } else {
      var insertion = '$count=true&';
      next = value.slice(0, questionMark + 1) + insertion + value.slice(questionMark + 1);
      if (typeof caret === 'number' && caret > questionMark) {
        newCaret = caret + insertion.length;
      }
    }
    var hadFocus = document.activeElement === input;
    setNativeInputValue(input, next);
    if (hadFocus && typeof newCaret === 'number') {
      try {
        input.setSelectionRange(newCaret, newCaret);
      } catch (e) {
        /* ignore */
      }
    }
  }

  /**
   * Visible advanced-query assistance: as soon as the URI field holds a
   * GET query using $filter/$search/$orderby (or $count), insert
   * $count=true right after the `?` and add `ConsistencyLevel: eventual`
   * plus `Content-Type: application/json` rows via Graph Explorer's own
   * Request-headers view. Nothing is modified behind the user's back —
   * every change lands in the query view before the request runs.
   *
   * While the user is *typing* (fromBlur = false) only the in-field
   * $count=true insertion runs — adding header rows there would switch to
   * the Request-headers tab and hand focus back with a stale caret, which
   * bounced the cursor back a few characters mid-filter. Header rows are
   * added once when Graph Explorer opens (scheduleStartupHeaders) and
   * re-ensured when the field loses focus or the query is run (fromBlur =
   * true), when stealing focus is harmless. Body-carrying methods
   * (POST/PUT/PATCH) get the Content-Type row even without advanced query
   * options.
   */
  function maybeAssistAdvancedQuery(fromBlur) {
    if (!state.settings.advancedQuery) {
      return;
    }
    var input = findEditorInput();
    if (!input || input.value.trim() === '') {
      return;
    }
    var methodControl = document.querySelector('[aria-label="HTTP request method option" i]');
    var method = methodControl && methodControl.textContent ? methodControl.textContent.trim().toUpperCase() : 'GET';
    var advanced = GEJQ.applyAdvancedQuery(input.value.trim(), method);
    // addCount (not addHeader) keys the insertion: a `/$count` path segment
    // needs the header but must not get a `$count=true` parameter added.
    if (advanced.addCount && !/[?&]\$count=/i.test(input.value)) {
      insertCountIntoEditor(input);
    }
    if (!fromBlur) {
      return; // never touch the headers tab while the user is typing
    }
    var rows = [];
    if (advanced.addHeader) {
      rows.push({ name: 'ConsistencyLevel', value: 'eventual' });
    }
    if (advanced.addHeader || method === 'POST' || method === 'PUT' || method === 'PATCH') {
      rows.push({ name: 'Content-Type', value: 'application/json' });
    }
    if (rows.length > 0) {
      ensureHeaderRows(rows);
    }
  }

  function findHeadersTab() {
    var byId = document.getElementById('request-headers');
    if (byId) {
      return byId;
    }
    var tabs = document.querySelectorAll('[role="tab"]');
    for (var i = 0; i < tabs.length; i++) {
      var id = (tabs[i].id || '').toLowerCase();
      var text = (tabs[i].textContent || '').toLowerCase();
      if (id.indexOf('header') !== -1 || text.indexOf('header') !== -1) {
        return tabs[i];
      }
    }
    return null;
  }

  function findHeaderInputs() {
    var nameInput =
      document.querySelector('input[name="name"]') || document.querySelector('input[placeholder="Key" i]');
    var valueInput =
      document.querySelector('input[name="value"]') || document.querySelector('input[placeholder="Value" i]');
    return nameInput && valueInput ? { name: nameInput, value: valueInput } : null;
  }

  /**
   * Add header rows through Graph Explorer's Request-headers tab so they
   * are visible (and persisted by GE) exactly like hand-entered ones.
   * Everything is asynchronous and defensive: the panel mounts only
   * after the tab is clicked (polled), and the Add button stays disabled
   * until React has processed the input values (also polled). A header
   * is only marked done once its row is verified present, so failed
   * attempts retry on the next occasion.
   */
  function ensureHeaderRows(rows, options) {
    var force = options && options.force === true;
    var pending = rows.filter(function (row) {
      if (headersInFlight[row.name]) {
        return false; // an add for this header is already running
      }
      if (force) {
        return true; // restore regardless of this session's earlier assists
      }
      try {
        return !sessionStorage.getItem(HEADER_ADDED_GUARD_PREFIX + row.name);
      } catch (e) {
        return true;
      }
    });
    if (pending.length === 0) {
      return;
    }
    pending.forEach(function (row) {
      headersInFlight[row.name] = true;
    });
    var headersTab = findHeadersTab();
    if (!headersTab) {
      return;
    }
    var previousTab = document.querySelector('[role="tab"][aria-selected="true"]');
    var restoreTab = previousTab && previousTab !== headersTab ? previousTab : null;
    // This can run while the user is typing in the URI field — remember
    // focus and caret so they can be handed back afterwards.
    var editorInput = findEditorInput();
    var refocusEditor = document.activeElement === editorInput ? editorInput : null;
    var editorCaret = refocusEditor ? refocusEditor.selectionStart : null;
    headersTab.click();

    function finish() {
      pending.forEach(function (row) {
        delete headersInFlight[row.name];
      });
      if (restoreTab) {
        try {
          restoreTab.click();
        } catch (e) {
          /* ignore */
        }
      }
      if (refocusEditor) {
        try {
          refocusEditor.focus();
          if (typeof editorCaret === 'number') {
            var caret = Math.min(editorCaret, refocusEditor.value.length);
            refocusEditor.setSelectionRange(caret, caret);
          }
        } catch (e) {
          /* ignore */
        }
      }
    }

    function addNext(index) {
      if (index >= pending.length) {
        finish();
        return;
      }
      var row = pending[index];
      waitForCondition(findHeaderInputs, 10, function (inputs) {
        var panelRoot = inputs.name.closest('[role="tabpanel"]') || inputs.name.parentElement.parentElement;
        if (panelRoot && panelRoot.textContent.indexOf(row.name) !== -1) {
          markHeaderAdded(row.name); // already present
          addNext(index + 1);
          return;
        }
        setNativeInputValue(inputs.name, row.name);
        setNativeInputValue(inputs.value, row.value);
        // The Add button enables only after React processes the values.
        waitForCondition(
          function () {
            var addButton = findAddButton(panelRoot || document);
            return addButton && !addButton.disabled ? addButton : null;
          },
          6,
          function (addButton) {
            addButton.click();
            // Mark as added right after the click (the button was enabled,
            // so the row is being added). Graph Explorer renders added rows
            // outside this input's container, so a DOM re-check here gives
            // false negatives — which previously left the session guard
            // unset and re-added ConsistencyLevel on every query edit.
            markHeaderAdded(row.name);
            setTimeout(function () {
              addNext(index + 1);
            }, 120);
          },
          finish
        );
      }, finish);
    }

    setTimeout(function () {
      addNext(0);
    }, 200);
  }

  function findAddButton(scope) {
    var buttons = scope.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      var text = (buttons[i].textContent || '').trim().toLowerCase();
      var label = (buttons[i].getAttribute('aria-label') || '').toLowerCase();
      if (text === 'add' || label.indexOf('add') !== -1) {
        return buttons[i];
      }
    }
    return null;
  }

  function markHeaderAdded(name) {
    try {
      sessionStorage.setItem(HEADER_ADDED_GUARD_PREFIX + name, '1');
    } catch (e) {
      /* ignore */
    }
  }

  /** Set a React-controlled input's value so the app sees the change. */
  function setNativeInputValue(input, value) {
    var descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(input, value);
    } else {
      input.value = value;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /**
   * Select a method in Graph Explorer's method dropdown by clicking
   * through its own UI (open the dropdown, click the matching option).
   * No-op when the method is already selected; best effort otherwise.
   */
  function ensureMethodSelected(method) {
    var control = document.querySelector('[aria-label="HTTP request method option" i]');
    if (!control) {
      return;
    }
    if ((control.textContent || '').trim().toUpperCase() === method) {
      return;
    }
    control.click();
    waitForCondition(
      function () {
        var options = document.querySelectorAll('[role="option"]');
        for (var i = 0; i < options.length; i++) {
          if ((options[i].textContent || '').trim().toUpperCase() === method) {
            return options[i];
          }
        }
        return null;
      },
      6,
      function (option) {
        option.click();
      },
      function () {
        try {
          control.click(); // close the dropdown we opened
        } catch (e) {
          /* ignore */
        }
      }
    );
  }

  /**
   * Re-populate Graph Explorer's request editor with a saved request —
   * URL (including query parameters), method, and the sanitized request
   * headers — purely by writing into Graph Explorer's own UI. No page
   * navigation: a reload would sign the user out. The version dropdown
   * follows the URL automatically (Graph Explorer parses it).
   */
  function populateGraphExplorer(method, url, headers, body) {
    method = String(method || 'GET').toUpperCase();
    var input = findEditorInput();
    if (!input) {
      return false;
    }
    setNativeInputValue(input, url);
    input.focus();
    ensureMethodSelected(method);
    if (headers && headers.length > 0) {
      ensureHeaderRows(headers, { force: true });
    }
    if (typeof body === 'string' && body !== '') {
      // GE's request body lives in a Monaco editor, which can't be set
      // reliably from outside — hand the body over via the clipboard.
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(body).catch(function () {
          legacyCopy(body);
        });
      } else {
        legacyCopy(body);
      }
      setWarning('Request body copied to clipboard — paste it into Graph Explorer’s Request body tab.');
    }
    return true;
  }

  // ---------------------------------------------------------- query history

  /**
   * Record the current query into the persistent history. Called when a
   * query is deliberately run (Enter, clicking a suggestion, leaving the
   * input) — not on every keystroke. Each entry remembers when it was
   * last used and which Graph request it ran against.
   */
  function recordQuery() {
    var query = state.query.trim();
    if (query === '') {
      return;
    }
    // Every caller runs runQuery() first — reuse its evaluation instead of
    // re-running the query (which doubled the cost on large datasets).
    var outcome = currentOutcome();
    if (outcome.error || outcome.empty) {
      return;
    }
    var response = selectedResponse();
    state.queryHistory = GEJQ.upsertQueryHistory(
      state.queryHistory,
      {
        query: query,
        language: state.settings.queryLanguage,
        lastUsed: Date.now(),
        context:
          response && !response.manual
            ? {
                method: response.method,
                url: response.url,
                headers: response.requestHeaders || [],
                body: response.requestBody || ''
              }
            : null
      },
      state.settings.historyLimit
    );
    storageSet(STORAGE_KEY_QUERY_HISTORY, state.queryHistory);
    renderQueryHistory();
  }

  function clearQueryHistory() {
    state.queryHistory = [];
    storageSet(STORAGE_KEY_QUERY_HISTORY, state.queryHistory);
    renderQueryHistory();
  }

  /** Merge a previously exported query library into the history. */
  function importQueryLibrary(text) {
    var parsed = GEJQ.safeJsonParse(text);
    if (!parsed.ok || !Array.isArray(parsed.value)) {
      ui.warning.textContent = 'Import failed: the file is not a query-library JSON export.';
      return;
    }
    var imported = 0;
    parsed.value.forEach(function (item) {
      if (!item || typeof item.query !== 'string' || typeof item.language !== 'string') {
        return;
      }
      var existing = state.queryHistory.filter(function (candidate) {
        return candidate.query === item.query && candidate.language === item.language;
      })[0];
      var tags = Array.isArray(item.tags)
        ? item.tags.filter(function (tag) {
            return typeof tag === 'string';
          })
        : [];
      if (existing) {
        existing.starred = existing.starred || item.starred === true;
        existing.label = existing.label || (typeof item.label === 'string' ? item.label : '');
        // Entries persisted by old extension versions may predate tags.
        existing.tags = Array.isArray(existing.tags) ? existing.tags : [];
        tags.forEach(function (tag) {
          if (existing.tags.indexOf(tag) === -1) {
            existing.tags.push(tag);
          }
        });
      } else {
        state.queryHistory.push({
          query: item.query,
          language: LANGUAGES[item.language] ? item.language : 'jmespath',
          lastUsed: typeof item.lastUsed === 'number' ? item.lastUsed : Date.now(),
          uses: typeof item.uses === 'number' ? item.uses : 1,
          context:
            item.context && typeof item.context.url === 'string'
              ? {
                  method: typeof item.context.method === 'string' ? item.context.method : 'GET',
                  url: item.context.url,
                  headers: Array.isArray(item.context.headers) ? item.context.headers : [],
                  body: typeof item.context.body === 'string' ? item.context.body : ''
                }
              : null,
          starred: item.starred === true,
          tags: tags,
          label: typeof item.label === 'string' ? item.label : ''
        });
      }
      imported++;
    });
    state.queryHistory.sort(function (a, b) {
      return (b.lastUsed || 0) - (a.lastUsed || 0);
    });
    state.queryHistory = GEJQ.trimQueryHistoryList(state.queryHistory, state.settings.historyLimit);
    persistQueryHistory();
    ui.warning.textContent = 'Imported ' + imported + ' quer' + (imported === 1 ? 'y' : 'ies') + ' into the library.';
  }

  function persistQueryHistory() {
    storageSet(STORAGE_KEY_QUERY_HISTORY, state.queryHistory);
    renderQueryHistory();
  }

  /** Swap the row's meta label for an inline comma-separated tag editor. */
  function editTags(item, row, metaLabel) {
    var input = el('input', 'gejq-tag-input');
    input.type = 'text';
    input.value = (item.tags || []).join(', ');
    input.placeholder = 'tags, comma separated';
    var done = false; // re-render blurs the input, which must not re-commit
    function commit() {
      if (done) {
        return;
      }
      done = true;
      var tags = [];
      input.value.split(',').forEach(function (tag) {
        var trimmed = tag.trim();
        if (trimmed !== '' && tags.indexOf(trimmed) === -1) {
          tags.push(trimmed);
        }
      });
      item.tags = tags;
      persistQueryHistory();
    }
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      } else if (event.key === 'Escape') {
        event.stopPropagation();
        done = true;
        renderQueryHistory(); // cancel
      }
    });
    input.addEventListener('blur', commit);
    row.replaceChild(input, metaLabel);
    input.focus();
  }

  /** Inline editor for a favorite's display label. */
  function editLabel(item, row, chip) {
    var input = el('input', 'gejq-tag-input');
    input.type = 'text';
    input.value = item.label || '';
    input.placeholder = 'name this query…';
    var done = false; // re-render blurs the input, which must not re-commit
    function commit() {
      if (done) {
        return;
      }
      done = true;
      item.label = input.value.trim();
      persistQueryHistory();
    }
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      } else if (event.key === 'Escape') {
        event.stopPropagation();
        done = true;
        renderQueryHistory();
      }
    });
    input.addEventListener('blur', commit);
    row.replaceChild(input, chip);
    input.focus();
  }

  function deleteHistoryEntry(item) {
    state.queryHistory = state.queryHistory.filter(function (candidate) {
      return !(candidate.query === item.query && candidate.language === item.language);
    });
    persistQueryHistory();
  }

  function queryHistoryRow(item) {
    var row = el('div', 'gejq-example');

    var star = button(
      'gejq-star' + (item.starred ? ' gejq-starred' : ''),
      item.starred ? '★' : '☆',
      item.starred ? 'Remove from favorites' : 'Pin to favorites',
      function () {
        item.starred = !item.starred;
        persistQueryHistory();
      }
    );
    row.appendChild(star);

    var chip = button(
      'gejq-chip',
      item.starred && item.label ? item.label : item.query,
      'Use this query' + (item.starred && item.label ? ': ' + item.query : ''),
      function () {
        if (LANGUAGES[item.language] && state.settings.queryLanguage !== item.language) {
          // Saved queries are already in their own language — switch
          // without attempting a conversion.
          state.settings.queryLanguage = item.language;
          saveSettings();
          pushSettingsToPage();
          applyLanguage();
        }
        setQuery(item.query);
      }
    );
    row.appendChild(chip);

    var metaText =
      GEJQ.formatTimestamp(item.lastUsed) +
      ' · ' +
      (LANGUAGES[item.language] ? LANGUAGES[item.language].label : item.language);
    if (item.context && item.context.url) {
      metaText += ' · ' + item.context.method + ' ' + GEJQ.summarizeUrl(item.context.url, 32);
    }
    if (Array.isArray(item.tags) && item.tags.length > 0) {
      metaText += ' · #' + item.tags.join(' #');
    }
    var metaLabel = el('span', 'gejq-example-label', metaText);
    row.appendChild(metaLabel);

    row.appendChild(
      button('gejq-icon-mini gejq-hover', '📋', 'Copy this query to the clipboard', function (event) {
        copyText(item.query, event.currentTarget, '✓');
      })
    );
    if (item.starred) {
      row.appendChild(
        button('gejq-icon-mini gejq-hover', '✎', 'Name this favorite', function () {
          editLabel(item, row, chip);
        })
      );
    }
    row.appendChild(
      button('gejq-icon-mini gejq-hover', '🏷', 'Edit tags (comma separated)', function () {
        editTags(item, row, metaLabel);
      })
    );
    row.appendChild(
      button('gejq-icon-mini gejq-hover', '✕', 'Delete this saved query', function () {
        deleteHistoryEntry(item);
      })
    );

    if (item.context && item.context.url && GEJQ.parseGraphRequest(item.context.url)) {
      var headerCount = Array.isArray(item.context.headers) ? item.context.headers.length : 0;
      var hasBody = typeof item.context.body === 'string' && item.context.body !== '';
      row.appendChild(
        button(
          'gejq-chip gejq-load',
          'Load ↗',
          'Re-populate Graph Explorer with this request: method, URL with query parameters' +
            (headerCount > 0 ? ', ' + headerCount + ' header(s)' : '') +
            (hasBody ? ', body → clipboard' : '') +
            ' — all in place, no reload',
          function () {
            populateGraphExplorer(item.context.method, item.context.url, item.context.headers, item.context.body);
          }
        )
      );
    }
    return row;
  }

  /** Tag chips for the filter bar (from the full history, not filtered). */
  function renderHistoryTagChips() {
    var container = ui.historyTagChips;
    clearChildren(container);
    var tags = GEJQ.distinctTags(state.queryHistory);
    container.style.display = tags.length === 0 ? 'none' : '';
    tags.forEach(function (tag) {
      var active = state.historyFilter.tags.indexOf(tag) !== -1;
      var chip = button('gejq-chip' + (active ? ' gejq-tag-active' : ''), '#' + tag, 'Filter by this tag', function () {
        var index = state.historyFilter.tags.indexOf(tag);
        if (index === -1) {
          state.historyFilter.tags.push(tag);
        } else {
          state.historyFilter.tags.splice(index, 1);
        }
        renderQueryHistory();
      });
      chip.setAttribute('aria-pressed', active ? 'true' : 'false');
      container.appendChild(chip);
    });
  }

  function renderQueryHistory() {
    var container = ui.queryHistoryList;
    clearChildren(container);
    renderHistoryTagChips();
    var total = state.queryHistory.length;
    if (total === 0) {
      ui.queryHistorySummary.textContent = 'Query history';
      ui.historyFilterRow.style.display = 'none';
      container.appendChild(
        el('p', 'gejq-help-text', 'Queries you run (Enter, or clicking a suggestion) are saved here with a timestamp and the Graph request they ran against. Star ★ a query to pin it; tag 🏷 queries to filter by tag.')
      );
      return;
    }
    ui.historyFilterRow.style.display = '';
    var filtered = GEJQ.filterQueryHistory(state.queryHistory, state.historyFilter, Date.now());
    var filterActive =
      state.historyFilter.text.trim() !== '' || state.historyFilter.sinceMs > 0 || state.historyFilter.tags.length > 0;
    ui.queryHistorySummary.textContent =
      'Query history (' + (filterActive ? filtered.length + '/' + total : total) + ')';
    if (filtered.length === 0) {
      container.appendChild(el('p', 'gejq-help-text', 'No saved queries match the filter.'));
      return;
    }
    var groups = GEJQ.groupQueryHistory(filtered);
    groups.forEach(function (group) {
      if (groups.length > 1 || group.title !== 'Recent') {
        container.appendChild(el('div', 'gejq-help-heading', group.title));
      }
      group.items.forEach(function (item) {
        container.appendChild(queryHistoryRow(item));
      });
    });
  }

  // ------------------------------------------------------------- clipboard

  function copyText(text, buttonNode, doneLabel) {
    var restore = buttonNode.textContent;
    function done(ok) {
      buttonNode.textContent = ok ? doneLabel : 'Failed';
      setTimeout(function () {
        buttonNode.textContent = restore;
      }, 1200);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () {
          done(true);
        },
        function () {
          done(legacyCopy(text));
        }
      );
    } else {
      done(legacyCopy(text));
    }
  }

  function legacyCopy(text) {
    var textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e) {
      ok = false;
    }
    document.body.removeChild(textarea);
    return ok;
  }

  function downloadText(text, filename, mimeType) {
    var blob = new Blob([text], { type: mimeType });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 5000);
  }

  // ------------------------------------------------------------- paste json

  function showPasteDialog() {
    ui.pasteOverlay.style.display = 'flex';
    ui.pasteInput.focus();
  }

  function hidePasteDialog() {
    ui.pasteOverlay.style.display = 'none';
    ui.pasteError.textContent = '';
    ui.pasteInput.value = '';
  }

  function submitPastedJson() {
    var text = ui.pasteInput.value.trim();
    if (text === '') {
      ui.pasteError.textContent = 'Paste some JSON first.';
      return;
    }
    var parsed = GEJQ.safeJsonParse(text);
    if (!parsed.ok) {
      ui.pasteError.textContent = 'Invalid JSON: ' + parsed.error;
      return;
    }
    manualCounter += 1;
    var id = 'manual-' + Date.now() + '-' + manualCounter;
    // Select the pasted source so it's shown now (badge reads "pinned").
    // followLatest stays on so a later real Graph response resumes live.
    addResponse({
      id: id,
      method: 'PASTE',
      url: 'pasted JSON #' + manualCounter,
      status: 0,
      manual: true,
      timestamp: Date.now(),
      json: parsed.value,
      size: text.length
    });
    state.selectedId = id;
    refreshHistorySelect();
    hidePasteDialog();
    openPanel();
    runQuery();
  }

  // ------------------------------------------------------- embed management

  function embedAnchor() {
    return document.getElementById(EMBED_ANCHOR_ID);
  }

  /**
   * Try to place the panel inside Graph Explorer's results area, splitting
   * it in half. Falls back to the floating drawer when the anchor is
   * missing. Idempotent — safe to call repeatedly from the observer.
   */
  function ensurePlacement() {
    var anchor = embedAnchor();

    if (anchor) {
      if (ui.host.parentElement !== anchor) {
        anchor.appendChild(ui.host);
      }
      // Split the results area: GE's own response view on the left, the
      // query tool on the right. Inline styles survive React re-renders
      // (React only diffs attributes it rendered itself).
      anchor.style.display = 'flex';
      anchor.style.flexDirection = 'row';
      anchor.style.alignItems = 'stretch';
      for (var i = 0; i < anchor.children.length; i++) {
        var child = anchor.children[i];
        if (child === ui.host) {
          continue;
        }
        child.style.flex = '1 1 50%';
        child.style.minWidth = '0';
      }
      if (!state.embedded) {
        state.embedded = true;
        state.open = !state.collapsedPref;
        ui.panel.classList.add('gejq-embedded');
      }
      applyVisibility();
      return;
    }

    if (state.embedded || !ui.host.parentElement) {
      if (state.embedded) {
        state.open = false; // floating drawer starts closed
      }
      state.embedded = false;
      ui.panel.classList.remove('gejq-embedded');
      (document.body || document.documentElement).appendChild(ui.host);
      applyVisibility();
    }
  }

  function scheduleEnsurePlacement() {
    if (embedTimer) {
      return;
    }
    embedTimer = setTimeout(function () {
      embedTimer = null;
      ensurePlacement();
    }, 150);
  }

  function applyVisibility() {
    if (state.embedded) {
      var anchor = embedAnchor();
      if (anchor) {
        anchor.style.gap = state.open ? '8px' : '0px';
      }
      // The host stays attached even when collapsed (its width shrinks to
      // zero) so the fixed-position FAB inside it can bring the panel back.
      ui.host.style.flex = state.open ? '0 0 ' + state.splitPct + '%' : '0 0 auto';
      ui.host.style.minWidth = '0';
      ui.panel.style.display = state.open ? '' : 'none';
      ui.panel.classList.add('gejq-open');
    } else {
      ui.host.style.flex = '';
      ui.host.style.minWidth = '';
      ui.panel.style.display = '';
      ui.panel.classList.toggle('gejq-open', state.open);
    }
    ui.fab.classList.toggle('gejq-hidden', state.open);
  }

  function openPanel() {
    state.open = true;
    state.collapsedPref = false;
    storageSet(STORAGE_KEY_COLLAPSED, false);
    applyVisibility();
    runQuery();
    ui.queryEditor.focus();
  }

  function closePanel() {
    state.open = false;
    state.collapsedPref = true;
    storageSet(STORAGE_KEY_COLLAPSED, true);
    applyVisibility();
  }

  // ----------------------------------------------------------- query editor

  /**
   * The query editor: CodeMirror 6 (syntax highlighting, bracket matching,
   * auto-closing brackets, undo history) when the vendored bundle loaded,
   * otherwise a plain textarea with the same behavior. The returned facade
   * hides the difference from the rest of the panel. Programmatic setValue/
   * replaceRange never fire the input handler — callers do their own
   * bookkeeping, mirroring how assigning input.value works.
   */
  function createQueryEditor(root) {
    var handlers = {
      input: function () {
        state.query = editor.getValue();
        scheduleQueryStore(); // debounced — no storage write per keystroke
        scheduleRun();
        updateAutocomplete();
      },
      // Recording happens only on deliberate runs (Enter or chip clicks) —
      // a blur handler would capture half-typed queries when the focus
      // moves to a suggestion chip.
      keydown: function (event) {
        if (autocomplete.open) {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            moveAutocomplete(event.key === 'ArrowDown' ? 1 : -1);
            return true;
          }
          if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault();
            acceptCompletion(autocomplete.result.items[autocomplete.activeIndex]);
            return true;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation(); // don't collapse the panel
            closeAutocomplete();
            return true;
          }
        }
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          runQuery();
          recordQuery();
          return true;
        }
        return false;
      },
      blur: function () {
        // Delayed so a mousedown on a completion row can land first.
        setTimeout(closeAutocomplete, 150);
      }
    };
    var useRich = state.settings.richEditor && window.GEJQCM;
    var editor = useRich ? codeMirrorEditor(handlers, root) : textareaEditor(handlers);
    editor.rich = !!useRich;
    return editor;
  }

  /**
   * Rebuild the query editor in place when the editor-mode setting flips.
   * Preserves the current query text and focus; destroys the old instance.
   */
  function swapQueryEditor() {
    if (!ui || !ui.queryEditor) {
      return;
    }
    var wantRich = state.settings.richEditor && window.GEJQCM;
    if (ui.queryEditor.rich === wantRich) {
      return;
    }
    var current = ui.queryEditor.getValue();
    var oldNode = ui.queryEditor.node;
    if (ui.queryEditor.destroy) {
      ui.queryEditor.destroy();
    }
    var next = createQueryEditor(ui.shadow);
    oldNode.parentNode.replaceChild(next.node, oldNode);
    ui.queryEditor = next;
    ui.queryInput = next.node;
    next.setLanguage(state.settings.queryLanguage);
    next.setPlaceholder(LANGUAGES[state.settings.queryLanguage].placeholder);
    next.setValue(current);
    closeAutocomplete();
  }

  function textareaEditor(handlers) {
    var input = el('textarea', 'gejq-query-input');
    input.rows = 2;
    input.spellcheck = false; // placeholder is set by applyLanguage()
    input.addEventListener('input', handlers.input);
    input.addEventListener('keydown', handlers.keydown);
    input.addEventListener('blur', handlers.blur);
    return {
      node: input,
      getValue: function () {
        return input.value;
      },
      setValue: function (text) {
        input.value = text;
      },
      getCaret: function () {
        return input.selectionStart !== null && input.selectionStart === input.selectionEnd ? input.selectionStart : null;
      },
      replaceRange: function (from, to, text) {
        input.value = input.value.slice(0, from) + text + input.value.slice(to);
        var caret = from + text.length;
        input.setSelectionRange(caret, caret);
      },
      focus: function () {
        input.focus();
      },
      setPlaceholder: function (text) {
        input.placeholder = text;
      },
      setLanguage: function () {},
      destroy: function () {}
    };
  }

  function codeMirrorEditor(handlers, root) {
    var cm = window.GEJQCM;
    var container = el('div', 'gejq-query-input gejq-query-editor');
    var programmatic = false;
    var languageCompartment = new cm.Compartment();
    var placeholderCompartment = new cm.Compartment();
    // Colors come from CSS variables so the editor follows the panel theme.
    var highlightStyle = cm.HighlightStyle.define([
      { tag: cm.tags.string, color: 'var(--gejq-tok-string)' },
      { tag: cm.tags.number, color: 'var(--gejq-tok-number)' },
      { tag: cm.tags.keyword, color: 'var(--gejq-tok-keyword)' },
      { tag: cm.tags.operator, color: 'var(--gejq-tok-operator)' },
      { tag: cm.tags.variableName, color: 'var(--gejq-tok-variable)' },
      { tag: cm.tags.propertyName, color: 'var(--gejq-tok-property)' },
      { tag: cm.tags.bracket, color: 'var(--gejq-tok-bracket)' }
    ]);
    function streamLanguage(languageKey) {
      return cm.StreamLanguage.define({
        token: function (stream) {
          var token = GEJQ.nextQueryToken(languageKey, stream.string, stream.pos);
          stream.pos = token.end > stream.pos ? token.end : stream.pos + 1;
          return token.type;
        }
      });
    }
    var view = new cm.EditorView({
      parent: container,
      // Critical inside a ShadowRoot: CodeMirror must know its root node so
      // it injects its stylesheet there (not document.head, which the shadow
      // DOM can't see) and reads the browser selection from the right root.
      // Without this the caret jumps to position 0 on every edit and the
      // screen-reader "announced" region shows through unstyled.
      root: root || document,
      state: cm.EditorState.create({
        doc: '',
        extensions: [
          cm.history(),
          cm.bracketMatching(),
          cm.closeBrackets(),
          cm.syntaxHighlighting(highlightStyle),
          languageCompartment.of(streamLanguage(state.settings.queryLanguage)),
          placeholderCompartment.of(cm.placeholder('')),
          cm.EditorView.lineWrapping,
          cm.EditorView.domEventHandlers({
            keydown: function (event) {
              return handlers.keydown(event) === true;
            },
            blur: function () {
              handlers.blur();
            }
          }),
          cm.EditorView.updateListener.of(function (update) {
            if (update.docChanged) {
              // DOM attributes are visible across content-script worlds
              // (a JS `value` expando would not be) — tests and page
              // tooling read the query from here.
              container.dataset.query = update.state.doc.toString();
              if (!programmatic) {
                handlers.input();
              }
            }
          }),
          cm.keymap.of(
            [{ key: 'Shift-Enter', run: cm.insertNewlineAndIndent }]
              .concat(cm.closeBracketsKeymap)
              .concat(cm.defaultKeymap)
              .concat(cm.historyKeymap)
          )
        ]
      })
    });
    function dispatchProgrammatic(spec) {
      programmatic = true;
      try {
        view.dispatch(spec);
      } finally {
        programmatic = false;
      }
    }
    var editor = {
      node: container,
      getValue: function () {
        return view.state.doc.toString();
      },
      setValue: function (text) {
        dispatchProgrammatic({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      },
      getCaret: function () {
        var range = view.state.selection.main;
        return range.empty ? range.head : null;
      },
      replaceRange: function (from, to, text) {
        dispatchProgrammatic({
          changes: { from: from, to: to, insert: text },
          selection: { anchor: from + text.length }
        });
      },
      focus: function () {
        view.focus();
      },
      setPlaceholder: function (text) {
        view.dispatch({ effects: placeholderCompartment.reconfigure(cm.placeholder(text)) });
      },
      setLanguage: function (languageKey) {
        view.dispatch({ effects: languageCompartment.reconfigure(streamLanguage(languageKey)) });
      },
      destroy: function () {
        view.destroy();
      }
    };
    container.dataset.query = '';
    return editor;
  }

  // ------------------------------------------------------------------ panel

  /** Documentation reference for the selected language, shown under the
   *  "Suggested for this response" section (replaces the old cheat sheet). */
  function renderSuggestionHelp() {
    var language = LANGUAGES[state.settings.queryLanguage];
    var box = ui.suggestionsHelp;
    clearChildren(box);
    var intro = el('p', 'gejq-help-text');
    intro.appendChild(document.createTextNode(language.blurb));
    var link = el('a', null, language.docsHost);
    link.href = language.docsUrl;
    link.target = '_blank';
    link.rel = 'noreferrer noopener';
    intro.appendChild(link);
    intro.appendChild(document.createTextNode('.'));
    box.appendChild(intro);
  }

  function buildUi(css) {
    var host = document.createElement('div');
    host.id = 'gejq-host';
    var shadow = host.attachShadow({ mode: 'open' });

    var style = document.createElement('style');
    style.textContent = css;
    shadow.appendChild(style);

    // Floating action button — shown whenever the panel is hidden.
    var fab = button('gejq-fab', '', 'Open Graph JSON Query panel', function () {
      openPanel();
    });
    fab.appendChild(el('span', 'gejq-fab-icon', '{;}'));
    fab.appendChild(el('span', 'gejq-fab-label', 'JSON Query'));
    var fabBadge = el('span', 'gejq-fab-badge', '0');
    fabBadge.style.display = 'none';
    fab.appendChild(fabBadge);
    shadow.appendChild(fab);

    // Panel
    var panel = el('aside', 'gejq-panel');
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'Graph JSON Query');

    var header = el('header', 'gejq-header');
    var title = el('div', 'gejq-title');
    title.appendChild(el('span', 'gejq-title-icon', '{;}'));
    var titleLabel = el('span', null, 'JSON Query'); // suffixed by applyLanguage()
    title.appendChild(titleLabel);
    header.appendChild(title);
    var headerButtons = el('div', 'gejq-header-buttons');
    headerButtons.appendChild(
      button('gejq-icon-button', 'Pin result', 'Use the current query result as a new queryable source', pinCurrentResult)
    );
    headerButtons.appendChild(
      button('gejq-icon-button', 'Paste JSON', 'Query JSON you paste in manually', showPasteDialog)
    );
    headerButtons.appendChild(
      button('gejq-icon-button gejq-close', '✕', 'Hide panel (Esc)', closePanel)
    );
    header.appendChild(headerButtons);
    panel.appendChild(header);

    // Drag handle on the panel's left edge: adjusts the split between
    // Graph Explorer's response view and the query tool (embedded mode).
    var resizer = el('div', 'gejq-resizer');
    resizer.title = 'Drag to resize';
    resizer.addEventListener('mousedown', function (event) {
      if (!state.embedded) {
        return;
      }
      event.preventDefault();
      var anchor = embedAnchor();
      if (!anchor) {
        return;
      }
      var rect = anchor.getBoundingClientRect();
      var previousUserSelect = document.body.style.userSelect;
      document.body.style.userSelect = 'none';
      function onMove(moveEvent) {
        var pct = ((rect.right - moveEvent.clientX) / rect.width) * 100;
        state.splitPct = Math.min(85, Math.max(15, Math.round(pct)));
        applyVisibility();
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.userSelect = previousUserSelect;
        storageSet(STORAGE_KEY_SPLIT, state.splitPct);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    panel.appendChild(resizer);

    // One row: live/pinned badge, the selected response as selectable
    // text, and a compact dropdown to pick among captured responses.
    var historyRow = el('div', 'gejq-history-row');
    var liveBadge = el('span', 'gejq-live-badge', '');
    liveBadge.style.display = 'none';
    liveBadge.setAttribute('aria-live', 'polite');
    historyRow.appendChild(liveBadge);
    var responseText = el('input', 'gejq-response-text');
    responseText.type = 'text';
    responseText.readOnly = true;
    responseText.placeholder = 'Waiting for Graph responses…';
    responseText.title = 'The response being queried (selectable)';
    historyRow.appendChild(responseText);
    var historySelect = el('select', 'gejq-history-select gejq-response-select');
    historySelect.title = 'Captured Graph responses (newest first)';
    historySelect.setAttribute('aria-label', 'Captured Graph responses');
    historySelect.addEventListener('change', function () {
      state.selectedId = historySelect.value;
      // "Live" means: viewing the newest real response. Selecting it (even
      // when a pinned-result snapshot sits above it) resumes live;
      // selecting a pin or an older response pins to it.
      var visible = visibleResponses();
      var newest = visible.length > 0 ? newestLiveResponse(visible) : null;
      state.followLatest = !!newest && newest.id === historySelect.value;
      runQuery();
    });
    historyRow.appendChild(historySelect);
    var diffToggle = button('gejq-icon-mini gejq-diff-toggle', '⇄', 'Compare this result against another captured response', function () {
      state.diff.active = !state.diff.active;
      if (state.diff.active) {
        refreshDiffSelect();
      }
      ui.diffRow.style.display = state.diff.active ? '' : 'none';
      diffToggle.classList.toggle('gejq-tag-active', state.diff.active);
      diffToggle.setAttribute('aria-pressed', state.diff.active ? 'true' : 'false');
      runQuery();
    });
    historyRow.appendChild(diffToggle);
    // In-panel shortcut for the auto-fetch-all-pages setting — the same
    // stored setting the popup edits, one click away from the data.
    var autoFetchToggle = button('gejq-icon-mini gejq-autofetch-toggle', '⟳', '', function () {
      state.settings.autoFetchNextLink = !state.settings.autoFetchNextLink;
      saveSettings();
      pushSettingsToPage();
      applyAutoFetchToggle();
    });
    historyRow.appendChild(autoFetchToggle);
    panel.appendChild(historyRow);

    // Compare mode: baseline picker (hidden until ⇄ is toggled on).
    var diffRow = el('div', 'gejq-diff-row');
    diffRow.style.display = 'none';
    diffRow.appendChild(el('span', 'gejq-diff-label', 'vs'));
    var diffSelect = el('select', 'gejq-history-select gejq-diff-select');
    diffSelect.title = 'Baseline response to compare against';
    diffSelect.addEventListener('change', function () {
      state.diff.baseId = diffSelect.value;
      runQuery();
    });
    diffRow.appendChild(diffSelect);
    panel.appendChild(diffRow);

    // Top half of the split: the query input with the language selector.
    var queryRow = el('div', 'gejq-query-row');
    var languageSelect = el('select', 'gejq-lang-select');
    languageSelect.title = 'Query language';
    Object.keys(LANGUAGES).forEach(function (languageKey) {
      var option = el('option', null, LANGUAGES[languageKey].label);
      option.value = languageKey;
      languageSelect.appendChild(option);
    });
    languageSelect.addEventListener('change', function () {
      switchLanguage(languageSelect.value);
    });
    queryRow.appendChild(languageSelect);
    var queryWrap = el('div', 'gejq-query-wrap');
    var queryEditor = createQueryEditor(shadow);
    var autocompleteList = el('div', 'gejq-autocomplete');
    autocompleteList.style.display = 'none';
    autocompleteList.setAttribute('role', 'listbox');
    queryWrap.appendChild(queryEditor.node);
    queryWrap.appendChild(autocompleteList);
    queryRow.appendChild(queryWrap);
    var graphEqToggle = button('gejq-icon-mini gejq-grapheq-toggle', '⇗', 'Show the Microsoft Graph (OData) equivalent of this query', function () {
      state.graphEqOpen = !state.graphEqOpen;
      graphEqToggle.classList.toggle('gejq-tag-active', state.graphEqOpen);
      graphEqToggle.setAttribute('aria-pressed', state.graphEqOpen ? 'true' : 'false');
      ui.graphEqRow.style.display = state.graphEqOpen ? '' : 'none';
      renderGraphEquivalent();
    });
    graphEqToggle.setAttribute('aria-pressed', 'false');
    queryRow.appendChild(graphEqToggle);
    panel.appendChild(queryRow);

    // Graph (OData) equivalent of the current query (hidden until ⇗).
    var graphEqRow = el('div', 'gejq-grapheq');
    graphEqRow.style.display = 'none';
    panel.appendChild(graphEqRow);

    var error = el('div', 'gejq-error');
    panel.appendChild(error);

    var warning = el('div', 'gejq-warning');
    panel.appendChild(warning);

    var metaRow = el('div', 'gejq-meta-row');
    // Auto-fetch progress + pause/resume/step controls share the metrics
    // line (hidden while no chain is active).
    var fetchStatus = el('div', 'gejq-fetch-status');
    fetchStatus.style.display = 'none';
    var meta = el('div', 'gejq-meta');
    var metaRight = el('div', 'gejq-meta gejq-meta-right');
    metaRow.appendChild(fetchStatus);
    metaRow.appendChild(meta);
    metaRow.appendChild(metaRight);
    panel.appendChild(metaRow);

    // Bottom half of the split: the query result.
    var resultOutput = el('div', 'gejq-result');
    panel.appendChild(resultOutput);

    // Suggestions (collapsible, open by default). This is also where the
    // language's documentation reference lives (the separate cheat sheet
    // was redundant with the data-driven suggestions).
    var suggestionsDetails = el('details', 'gejq-help gejq-suggestions-details');
    suggestionsDetails.open = true;
    suggestionsDetails.appendChild(el('summary', null, 'Suggested for this response'));
    var suggestionsHelp = el('div', 'gejq-suggestions-help');
    suggestionsDetails.appendChild(suggestionsHelp);
    var suggestions = el('div', 'gejq-suggestions');
    suggestionsDetails.appendChild(suggestions);
    panel.appendChild(suggestionsDetails);

    // Query history (persisted, newest first) with a filter bar.
    var queryHistoryDetails = el('details', 'gejq-help');
    var queryHistorySummary = el('summary', null, 'Query history');
    queryHistoryDetails.appendChild(queryHistorySummary);
    var queryHistoryBody = el('div', 'gejq-help-body');

    var historyFilterRow = el('div', 'gejq-hist-filter');
    var historyFilterText = el('input', 'gejq-hist-filter-text');
    historyFilterText.type = 'search';
    historyFilterText.placeholder = 'Filter queries…';
    historyFilterText.addEventListener('input', function () {
      state.historyFilter.text = historyFilterText.value;
      renderQueryHistory();
    });
    historyFilterRow.appendChild(historyFilterText);
    var historyFilterTime = el('select', 'gejq-hist-filter-time');
    historyFilterTime.title = 'Only queries used within…';
    [
      { label: 'Any time', ms: 0 },
      { label: 'Last hour', ms: 60 * 60 * 1000 },
      { label: 'Last 24 h', ms: 24 * 60 * 60 * 1000 },
      { label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
      { label: 'Last 30 days', ms: 30 * 24 * 60 * 60 * 1000 }
    ].forEach(function (choice) {
      var option = el('option', null, choice.label);
      option.value = String(choice.ms);
      historyFilterTime.appendChild(option);
    });
    historyFilterTime.addEventListener('change', function () {
      state.historyFilter.sinceMs = parseInt(historyFilterTime.value, 10) || 0;
      renderQueryHistory();
    });
    historyFilterRow.appendChild(historyFilterTime);
    queryHistoryBody.appendChild(historyFilterRow);
    var historyTagChips = el('div', 'gejq-chip-row gejq-hist-tags');
    queryHistoryBody.appendChild(historyTagChips);

    var queryHistoryList = el('div', 'gejq-query-history');
    queryHistoryBody.appendChild(queryHistoryList);

    var historyActions = el('div', 'gejq-history-actions');
    var clearArmed = null;
    var clearButton = button('gejq-icon-button', 'Clear history', 'Delete all saved queries (asks to confirm)', function () {
      if (clearArmed === null) {
        clearButton.textContent = 'Really clear? Click again';
        clearButton.classList.add('gejq-danger');
        clearArmed = setTimeout(function () {
          clearArmed = null;
          clearButton.textContent = 'Clear history';
          clearButton.classList.remove('gejq-danger');
        }, 3000);
        return;
      }
      clearTimeout(clearArmed);
      clearArmed = null;
      clearButton.textContent = 'Clear history';
      clearButton.classList.remove('gejq-danger');
      clearQueryHistory();
    });
    historyActions.appendChild(clearButton);
    historyActions.appendChild(
      button('gejq-icon-button', 'Export', 'Download the query library as JSON (queries, favorites, tags)', function () {
        downloadText(JSON.stringify(state.queryHistory, null, 2), GEJQ.exportFilename('', 'json').replace('graph-query', 'query-library'), 'application/json');
      })
    );
    var importInput = el('input');
    importInput.type = 'file';
    importInput.accept = '.json,application/json';
    importInput.style.display = 'none';
    importInput.addEventListener('change', function () {
      var file = importInput.files && importInput.files[0];
      importInput.value = '';
      if (!file) {
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        importQueryLibrary(String(reader.result || ''));
      };
      reader.readAsText(file);
    });
    historyActions.appendChild(importInput);
    historyActions.appendChild(
      button('gejq-icon-button', 'Import', 'Merge a previously exported query library', function () {
        importInput.click();
      })
    );
    queryHistoryBody.appendChild(historyActions);
    queryHistoryDetails.appendChild(queryHistoryBody);
    panel.appendChild(queryHistoryDetails);

    var footer = el('footer', 'gejq-footer');

    // Format switch: Copy and Download follow the selected format.
    var formatSwitch = el('div', 'gejq-seg');
    formatSwitch.setAttribute('role', 'group');
    formatSwitch.setAttribute('aria-label', 'Result view and export format');
    var jsonToggle = button('gejq-seg-btn', 'JSON', 'JSON view / export as JSON', function () {
      setFormat('json');
    });
    var csvToggle = button('gejq-seg-btn', 'CSV', 'Table view / export as CSV', function () {
      setFormat('csv');
    });
    var treeToggle = button('gejq-seg-btn', 'Tree', 'Interactive tree — click a property to use its path as the query', function () {
      setFormat('tree');
    });
    formatSwitch.appendChild(jsonToggle);
    formatSwitch.appendChild(csvToggle);
    formatSwitch.appendChild(treeToggle);
    footer.appendChild(formatSwitch);

    var copyButton = button('gejq-action', 'Copy', 'Copy the query result in the selected format', function () {
      var payload = exportPayload();
      if (payload !== null) {
        copyText(payload.text, copyButton, 'Copied ✓');
      }
    });
    // In CSV (table) mode, this picks the delimiter for Copy and Download.
    // Hidden in JSON/Tree modes (see updateExportButtons).
    var copyFormatSelect = el('select', 'gejq-copy-format');
    copyFormatSelect.title = 'Copy / Download format';
    [
      { value: 'csv', label: 'CSV' },
      { value: 'tsv', label: 'TSV' }
    ].forEach(function (choice) {
      var option = el('option', null, choice.label);
      option.value = choice.value;
      copyFormatSelect.appendChild(option);
    });
    copyFormatSelect.value = state.copyFormat;
    copyFormatSelect.addEventListener('change', function () {
      state.copyFormat = copyFormatSelect.value === 'tsv' ? 'tsv' : 'csv';
      storageSet(STORAGE_KEY_COPY_FORMAT, state.copyFormat);
    });
    var downloadButton = button('gejq-action', 'Download', 'Download the query result in the selected format', function () {
      var payload = exportPayload();
      if (payload !== null) {
        // UTF-8 BOM so Excel opens downloaded CSV/TSV with correct accents.
        var text = payload.bom ? '\uFEFF' + payload.text : payload.text;
        downloadText(text, payload.filename, payload.mime);
      }
    });
    footer.appendChild(copyButton);
    footer.appendChild(copyFormatSelect);
    footer.appendChild(downloadButton);
    panel.appendChild(footer);

    shadow.appendChild(panel);

    // Paste dialog
    var pasteOverlay = el('div', 'gejq-overlay');
    pasteOverlay.style.display = 'none';
    var pasteDialog = el('div', 'gejq-dialog');
    pasteDialog.setAttribute('role', 'dialog');
    pasteDialog.setAttribute('aria-label', 'Paste JSON');
    pasteDialog.appendChild(el('div', 'gejq-dialog-title', 'Paste JSON to query'));
    var pasteInput = el('textarea', 'gejq-paste-input');
    pasteInput.placeholder = '{ "value": [ … ] }';
    pasteInput.spellcheck = false;
    pasteDialog.appendChild(pasteInput);
    var pasteError = el('div', 'gejq-error');
    pasteDialog.appendChild(pasteError);
    var dialogButtons = el('div', 'gejq-dialog-buttons');
    dialogButtons.appendChild(button('gejq-action', 'Cancel', null, hidePasteDialog));
    dialogButtons.appendChild(button('gejq-action gejq-primary', 'Use JSON', null, submitPastedJson));
    pasteDialog.appendChild(dialogButtons);
    pasteOverlay.appendChild(pasteDialog);
    pasteOverlay.addEventListener('click', function (event) {
      if (event.target === pasteOverlay) {
        hidePasteDialog();
      }
    });
    shadow.appendChild(pasteOverlay);

    // Esc closes dialog first, then panel.
    shadow.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        if (pasteOverlay.style.display !== 'none') {
          hidePasteDialog();
        } else if (state.open) {
          closePanel();
        }
      }
    });

    ui = {
      host: host,
      shadow: shadow,
      fab: fab,
      fabBadge: fabBadge,
      panel: panel,
      titleLabel: titleLabel,
      historySelect: historySelect,
      liveBadge: liveBadge,
      responseText: responseText,
      autoFetchToggle: autoFetchToggle,
      queryInput: queryEditor.node,
      queryEditor: queryEditor,
      autocompleteList: autocompleteList,
      graphEqToggle: graphEqToggle,
      graphEqRow: graphEqRow,
      error: error,
      warning: warning,
      fetchStatus: fetchStatus,
      meta: meta,
      metaRight: metaRight,
      diffRow: diffRow,
      diffSelect: diffSelect,
      resultOutput: resultOutput,
      suggestions: suggestions,
      suggestionsHelp: suggestionsHelp,
      suggestionsDetails: suggestionsDetails,
      languageSelect: languageSelect,
      queryHistoryList: queryHistoryList,
      queryHistorySummary: queryHistorySummary,
      historyFilterRow: historyFilterRow,
      historyTagChips: historyTagChips,
      copyButton: copyButton,
      copyFormatSelect: copyFormatSelect,
      downloadButton: downloadButton,
      jsonToggle: jsonToggle,
      csvToggle: csvToggle,
      treeToggle: treeToggle,
      pasteOverlay: pasteOverlay,
      pasteInput: pasteInput,
      pasteError: pasteError
    };

    refreshHistorySelect();
    updateBadge();
    updateExportButtons();
    ensurePlacement();
    renderQueryHistory();
    applyAutoFetchToggle();
    applyLanguage(); // sets placeholder, rebuilds the cheat sheet, runs the query

    // Graph Explorer is a React app: the results area comes and goes as
    // the user navigates and runs queries. Keep the panel attached.
    var observer = new MutationObserver(function () {
      var anchor = embedAnchor();
      var attached = anchor && ui.host.parentElement === anchor;
      if ((anchor && !attached) || (!anchor && state.embedded) || !ui.host.isConnected) {
        scheduleEnsurePlacement();
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  // ---------------------------------------------------------------- wiring

  window.addEventListener('message', function (event) {
    if (event.source !== window || event.origin !== window.location.origin) {
      return;
    }
    var data = event.data;
    if (!data || data.source !== MESSAGE_SOURCE) {
      return;
    }
    if (data.type === 'graph-fetch-progress') {
      handleFetchProgress(data.payload);
      return;
    }
    if (data.type !== 'graph-response') {
      return;
    }
    var payload = data.payload;
    if (!payload || typeof payload.id !== 'string' || typeof payload.url !== 'string') {
      return;
    }
    if (payload.json === undefined && !payload.tooLarge) {
      return;
    }
    // Distinguish user-run queries from Graph Explorer's own background
    // calls. Aggregated auto-fetch entries inherit the classification of
    // the first page they extend (their URL may no longer match the URI
    // field by the time all pages have been fetched).
    var background;
    var pages = typeof payload.pages === 'number' ? payload.pages : 0;
    var priorEntry = pages > 0
      ? state.responses.filter(function (entry) {
          return entry.url === payload.url && !entry.pages;
        })[0]
      : undefined;
    if (priorEntry) {
      background = priorEntry.background === true;
    } else {
      var editor = findEditorInput();
      background = GEJQ.classifyBackgroundRequest(
        payload.url,
        editor ? editor.value : '',
        lastRunInteraction ? Date.now() - lastRunInteraction : -1
      );
    }
    var requestHeaders = [];
    if (Array.isArray(payload.requestHeaders)) {
      payload.requestHeaders.forEach(function (pair) {
        if (requestHeaders.length < 20 && pair && typeof pair.name === 'string' && typeof pair.value === 'string') {
          requestHeaders.push({ name: pair.name, value: pair.value });
        }
      });
    }
    addResponse({
      id: payload.id,
      method: typeof payload.method === 'string' ? payload.method : 'GET',
      url: payload.url,
      status: typeof payload.status === 'number' ? payload.status : 0,
      timestamp: typeof payload.timestamp === 'number' ? payload.timestamp : Date.now(),
      json: payload.json,
      size: typeof payload.size === 'number' ? payload.size : 0,
      pages: pages,
      partial: payload.partial === true,
      truncated: payload.truncated === true,
      stopReason: typeof payload.stopReason === 'string' ? payload.stopReason : '',
      background: background,
      requestHeaders: requestHeaders,
      requestBody: typeof payload.requestBody === 'string' ? payload.requestBody : '',
      tooLarge: payload.tooLarge === true
    });
  });

  /** Auto-fetch progress events drive the controls on the metrics row. */
  function handleFetchProgress(payload) {
    if (!ui || !payload) {
      return;
    }
    fetchProgress = payload.state === 'done' ? null : payload;
    renderFetchStatus();
  }

  function init() {
    fetch(chrome.runtime.getURL('src/content.css'))
      .then(function (response) {
        return response.text();
      })
      .catch(function () {
        return '';
      })
      .then(function (css) {
        storageGet(
          [STORAGE_KEY_QUERY, STORAGE_KEY_COLLAPSED, STORAGE_KEY_FORMAT, STORAGE_KEY_COPY_FORMAT, STORAGE_KEY_SPLIT, STORAGE_KEY_SETTINGS, STORAGE_KEY_QUERY_HISTORY],
          function (items) {
            state.collapsedPref = items[STORAGE_KEY_COLLAPSED] === true;
            state.format = ['csv', 'tree'].indexOf(items[STORAGE_KEY_FORMAT]) !== -1 ? items[STORAGE_KEY_FORMAT] : 'json';
            state.copyFormat = items[STORAGE_KEY_COPY_FORMAT] === 'tsv' ? 'tsv' : 'csv';
            state.splitPct = GEJQ.clampInt(items[STORAGE_KEY_SPLIT], 15, 85, 50);
            state.settings = GEJQ.normalizeSettings(items[STORAGE_KEY_SETTINGS]);
            state.queryHistory = Array.isArray(items[STORAGE_KEY_QUERY_HISTORY])
              ? items[STORAGE_KEY_QUERY_HISTORY]
              : [];
            buildUi(css);
            var savedQuery = items[STORAGE_KEY_QUERY];
            if (savedQuery && state.query === '') {
              state.query = savedQuery;
              ui.queryEditor.setValue(savedQuery);
            }
            pushSettingsToPage();
            maybeAutoSignIn();
            trackRunInteractions();
            scheduleStartupHeaders();
          }
        );
      });

    // Alt+Q (the "focus-query-input" command) routed via the service worker.
    try {
      chrome.runtime.onMessage.addListener(function (message) {
        if (message && message.type === 'gejq-focus-query' && ui) {
          openPanel();
        }
      });
    } catch (e) {
      /* runtime messaging unavailable */
    }

    try {
      chrome.storage.onChanged.addListener(function (changes, areaName) {
        if (areaName !== 'local' || !changes[STORAGE_KEY_SETTINGS]) {
          return;
        }
        var previousLanguage = state.settings.queryLanguage;
        var previousShowBackground = state.settings.showBackgroundRequests;
        var previousRichEditor = state.settings.richEditor;
        state.settings = GEJQ.normalizeSettings(changes[STORAGE_KEY_SETTINGS].newValue);
        pushSettingsToPage();
        applyAutoFetchToggle();
        if (ui && state.settings.richEditor !== previousRichEditor) {
          swapQueryEditor();
        }
        if (ui && state.settings.showBackgroundRequests !== previousShowBackground) {
          refreshHistorySelect();
          updateBadge();
          runQuery();
        }
        // A lowered history limit trims the stored history right away
        // (favorites are exempt).
        var limit = state.settings.historyLimit;
        if (limit > 0 && state.queryHistory.length > limit) {
          state.queryHistory = GEJQ.trimQueryHistoryList(state.queryHistory, limit);
          storageSet(STORAGE_KEY_QUERY_HISTORY, state.queryHistory);
          if (ui) {
            renderQueryHistory();
          }
        }
        if (ui && state.settings.queryLanguage !== previousLanguage) {
          convertCurrentQuery(previousLanguage, state.settings.queryLanguage);
          applyLanguage();
        }
      });
    } catch (e) {
      /* storage unavailable — settings stay at their defaults */
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
