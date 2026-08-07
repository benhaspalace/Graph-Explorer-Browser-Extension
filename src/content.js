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
  var STORAGE_KEY_SETTINGS = 'gejq.settings';
  var STORAGE_KEY_QUERY_HISTORY = 'gejq.queryHistory';
  var AUTO_SIGNIN_GUARD = 'gejq.autoSignInAttempted';
  var DEFAULT_SETTINGS = {
    advancedQuery: true,
    autoSignIn: true,
    autoFetchNextLink: false,
    queryLanguage: 'jmespath',
    historyLimit: 50 // 0 = unlimited
  };
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
    format: 'json', // export format: 'json' | 'csv'
    settings: DEFAULT_SETTINGS,
    queryHistory: [] // executed queries, newest first (persisted)
  };

  var ui = null; // populated by buildUi()
  var runTimer = null;
  var embedTimer = null;
  var manualCounter = 0;

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

  function renderResult(value) {
    var output = ui.resultOutput;
    clearChildren(output);
    if (value === undefined) {
      output.appendChild(el('div', 'gejq-empty', 'The query returned no result (undefined).'));
      return;
    }
    var text = JSON.stringify(value, null, 2);
    if (typeof text !== 'string') {
      text = String(value);
    }
    if (text.length > RENDER_LIMIT) {
      output.appendChild(
        el(
          'div',
          'gejq-notice',
          'Result is too large to display (' + GEJQ.formatBytes(text.length) + '). Showing the first part — use Copy or Download for the full result.'
        )
      );
      output.appendChild(el('pre', 'gejq-json', text.slice(0, RENDER_LIMIT) + '\n…'));
      return;
    }
    var pre = el('pre', 'gejq-json');
    if (text.length > HIGHLIGHT_LIMIT) {
      pre.textContent = text;
    } else {
      appendHighlightedJson(pre, text);
    }
    output.appendChild(pre);
  }

  // ------------------------------------------------------------ query logic

  function selectedResponse() {
    if (state.responses.length === 0) {
      return null;
    }
    if (state.followLatest || state.selectedId === null) {
      return state.responses[0];
    }
    for (var i = 0; i < state.responses.length; i++) {
      if (state.responses[i].id === state.selectedId) {
        return state.responses[i];
      }
    }
    return state.responses[0];
  }

  /** Evaluate `query` against `json` in the selected query language. */
  function executeQuery(json, query) {
    if (state.settings.queryLanguage === 'jsonpath') {
      return JSONPath.JSONPath({ path: query, json: json, wrap: true });
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
      return { value: undefined, error: e && e.message ? e.message : String(e) };
    }
  }

  function runQuery() {
    var response = selectedResponse();

    if (!response) {
      ui.error.textContent = '';
      ui.meta.textContent = '';
      clearChildren(ui.resultOutput);
      ui.resultOutput.appendChild(
        el(
          'div',
          'gejq-empty',
          'Run a query in Graph Explorer — the response will appear here, ready for JMESPath querying. Or use “Paste JSON” to bring your own data.'
        )
      );
      updateExportButtons();
      return;
    }

    if (response.tooLarge) {
      ui.error.textContent = '';
      ui.meta.textContent = '';
      clearChildren(ui.resultOutput);
      ui.resultOutput.appendChild(
        el(
          'div',
          'gejq-notice',
          'This response (' + GEJQ.formatBytes(response.size) + ') is too large to capture. Try narrowing the Graph query with $select or $top.'
        )
      );
      updateExportButtons();
      return;
    }

    var outcome = currentResult();
    if (outcome.error) {
      ui.error.textContent = outcome.error;
      updateExportButtons();
      return; // keep previous result visible while the user types
    }
    ui.error.textContent = '';
    renderResult(outcome.value);
    ui.meta.textContent = GEJQ.describeResult(outcome.value);
    updateExportButtons();
    renderSuggestions(response.json);
  }

  function scheduleRun() {
    if (runTimer) {
      clearTimeout(runTimer);
    }
    runTimer = setTimeout(runQuery, 180);
  }

  // ------------------------------------------------------------- exporting

  /** The current result in the selected export format, or null. */
  function exportPayload() {
    var outcome = currentResult();
    if (outcome.error || outcome.value === undefined) {
      return null;
    }
    if (state.format === 'csv') {
      var csv = GEJQ.toCsv(outcome.value);
      if (csv === null) {
        return null;
      }
      return { text: csv, filename: 'graph-query-result.csv', mime: 'text/csv' };
    }
    return {
      text: JSON.stringify(outcome.value, null, 2),
      filename: 'graph-query-result.json',
      mime: 'application/json'
    };
  }

  function updateExportButtons() {
    var outcome = currentResult();
    var hasResult = !outcome.error && outcome.value !== undefined;
    var csv = hasResult ? GEJQ.toCsv(outcome.value) : null;
    ui.csvToggle.disabled = !hasResult || csv === null;
    ui.csvToggle.title =
      hasResult && csv === null
        ? 'This result cannot be represented as CSV (needs an array of objects or scalar values)'
        : 'Export as CSV';
    ui.jsonToggle.classList.toggle('gejq-seg-active', state.format === 'json');
    ui.csvToggle.classList.toggle('gejq-seg-active', state.format === 'csv');
    ui.jsonToggle.setAttribute('aria-pressed', state.format === 'json' ? 'true' : 'false');
    ui.csvToggle.setAttribute('aria-pressed', state.format === 'csv' ? 'true' : 'false');
    var exportable = hasResult && (state.format === 'json' || csv !== null);
    ui.copyButton.disabled = !exportable;
    ui.downloadButton.disabled = !exportable;
  }

  function setFormat(format) {
    state.format = format;
    storageSet(STORAGE_KEY_FORMAT, format);
    updateExportButtons();
  }

  // -------------------------------------------------------------- settings

  function normalizeSettings(raw) {
    var historyLimit = raw && typeof raw.historyLimit === 'number' && raw.historyLimit >= 0
      ? Math.floor(raw.historyLimit)
      : DEFAULT_SETTINGS.historyLimit;
    return {
      advancedQuery: !raw || raw.advancedQuery !== false,
      autoSignIn: !raw || raw.autoSignIn !== false,
      autoFetchNextLink: !!raw && raw.autoFetchNextLink === true,
      queryLanguage: raw && LANGUAGES[raw.queryLanguage] ? raw.queryLanguage : DEFAULT_SETTINGS.queryLanguage,
      historyLimit: historyLimit
    };
  }

  function saveSettings() {
    storageSet(STORAGE_KEY_SETTINGS, state.settings);
  }

  /** Forward settings the MAIN-world interceptor needs via postMessage. */
  function pushSettingsToPage() {
    try {
      window.postMessage(
        {
          source: SETTINGS_SOURCE,
          settings: {
            advancedQuery: state.settings.advancedQuery,
            autoFetchNextLink: state.settings.autoFetchNextLink
          }
        },
        window.location.origin
      );
    } catch (e) {
      /* ignore */
    }
  }

  /** Re-apply everything that depends on the selected query language. */
  function applyLanguage() {
    var language = LANGUAGES[state.settings.queryLanguage];
    ui.queryInput.placeholder = language.placeholder;
    if (ui.languageSelect.value !== state.settings.queryLanguage) {
      ui.languageSelect.value = state.settings.queryLanguage;
    }
    rebuildHelp();
    runQuery();
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
    var time = new Date(entry.timestamp);
    var pad = function (n) {
      return (n < 10 ? '0' : '') + n;
    };
    var clock = pad(time.getHours()) + ':' + pad(time.getMinutes()) + ':' + pad(time.getSeconds());
    var status = entry.manual ? 'pasted' : entry.status;
    if (entry.pages) {
      status += ' · ' + entry.pages + ' pages';
    }
    return clock + ' · ' + entry.method + ' ' + GEJQ.summarizeUrl(entry.url, 60) + ' (' + status + ')';
  }

  function refreshHistorySelect() {
    var select = ui.historySelect;
    clearChildren(select);
    if (state.responses.length === 0) {
      var placeholder = el('option', null, 'Waiting for Graph responses…');
      placeholder.value = '';
      select.appendChild(placeholder);
      select.disabled = true;
      return;
    }
    select.disabled = false;
    state.responses.forEach(function (entry) {
      var option = el('option', null, optionLabel(entry));
      option.value = entry.id;
      select.appendChild(option);
    });
    var selected = selectedResponse();
    select.value = selected ? selected.id : state.responses[0].id;
  }

  function addResponse(entry) {
    state.responses.unshift(entry);
    state.responses = GEJQ.trimHistory(state.responses, MAX_HISTORY);
    if (state.followLatest) {
      state.selectedId = entry.id;
    }
    if (ui) {
      refreshHistorySelect();
      updateBadge();
      pulseFab();
      if (state.open && state.followLatest) {
        runQuery();
      }
    }
  }

  function updateBadge() {
    var count = state.responses.length;
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
    var container = ui.suggestions;
    clearChildren(container);
    var queries = GEJQ.suggestQueries(json, state.settings.queryLanguage);
    if (queries.length === 0) {
      return;
    }
    container.appendChild(el('div', 'gejq-help-heading', 'Suggested for this response'));
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
    ui.queryInput.value = query;
    storageSet(STORAGE_KEY_QUERY, query);
    runQuery();
    recordQuery();
    ui.queryInput.focus();
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
    var outcome = currentResult();
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
        context: response && !response.manual ? { method: response.method, url: response.url } : null
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

  function renderQueryHistory() {
    var container = ui.queryHistoryList;
    clearChildren(container);
    ui.queryHistorySummary.textContent = 'Query history' + (state.queryHistory.length ? ' (' + state.queryHistory.length + ')' : '');
    if (state.queryHistory.length === 0) {
      container.appendChild(
        el('p', 'gejq-help-text', 'Queries you run (Enter, or clicking a suggestion) are saved here with a timestamp and the Graph request they ran against.')
      );
      return;
    }
    state.queryHistory.forEach(function (item) {
      var row = el('div', 'gejq-example');
      row.appendChild(
        button('gejq-chip', item.query, 'Use this query', function () {
          if (LANGUAGES[item.language] && state.settings.queryLanguage !== item.language) {
            state.settings.queryLanguage = item.language;
            saveSettings();
            pushSettingsToPage();
            applyLanguage();
          }
          setQuery(item.query);
        })
      );
      var metaText =
        GEJQ.formatTimestamp(item.lastUsed) +
        ' · ' +
        (LANGUAGES[item.language] ? LANGUAGES[item.language].label : item.language);
      if (item.context && item.context.url) {
        metaText += ' · ' + item.context.method + ' ' + GEJQ.summarizeUrl(item.context.url, 32);
      }
      row.appendChild(el('span', 'gejq-example-label', metaText));
      container.appendChild(row);
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
    addResponse({
      id: 'manual-' + Date.now() + '-' + manualCounter,
      method: 'PASTE',
      url: 'pasted JSON #' + manualCounter,
      status: 0,
      manual: true,
      timestamp: Date.now(),
      json: parsed.value,
      size: text.length
    });
    state.followLatest = true;
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
      ui.host.style.flex = state.open ? '1 1 50%' : '0 0 auto';
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
    ui.queryInput.focus();
  }

  function closePanel() {
    state.open = false;
    state.collapsedPref = true;
    storageSet(STORAGE_KEY_COLLAPSED, true);
    applyVisibility();
  }

  // ------------------------------------------------------------------ panel

  /** Refill the cheat sheet for the selected query language. */
  function rebuildHelp() {
    var language = LANGUAGES[state.settings.queryLanguage];
    ui.helpSummary.textContent = language.label + ' cheat sheet';
    var body = ui.helpBody;
    clearChildren(body);

    var intro = el('p', 'gejq-help-text');
    intro.appendChild(document.createTextNode(language.blurb));
    var link = el('a', null, language.docsHost);
    link.href = language.docsUrl;
    link.target = '_blank';
    link.rel = 'noreferrer noopener';
    intro.appendChild(link);
    intro.appendChild(document.createTextNode('.'));
    body.appendChild(intro);

    language.examples.forEach(function (example) {
      var row = el('div', 'gejq-example');
      row.appendChild(
        button('gejq-chip', example.query, 'Use this query', function () {
          setQuery(example.query);
        })
      );
      row.appendChild(el('span', 'gejq-example-label', example.label));
      body.appendChild(row);
    });
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
    title.appendChild(el('span', null, 'JSON Query (JMESPath)'));
    header.appendChild(title);
    var headerButtons = el('div', 'gejq-header-buttons');
    headerButtons.appendChild(
      button('gejq-icon-button', 'Paste JSON', 'Query JSON you paste in manually', showPasteDialog)
    );
    headerButtons.appendChild(
      button('gejq-icon-button gejq-close', '✕', 'Hide panel (Esc)', closePanel)
    );
    header.appendChild(headerButtons);
    panel.appendChild(header);

    var historyRow = el('div', 'gejq-history-row');
    var historySelect = el('select', 'gejq-history-select');
    historySelect.title = 'Captured Graph responses (newest first)';
    historySelect.addEventListener('change', function () {
      state.selectedId = historySelect.value;
      state.followLatest = state.responses.length > 0 && state.responses[0].id === historySelect.value;
      runQuery();
    });
    historyRow.appendChild(historySelect);
    panel.appendChild(historyRow);

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
      state.settings.queryLanguage = LANGUAGES[languageSelect.value] ? languageSelect.value : 'jmespath';
      saveSettings();
      pushSettingsToPage();
      applyLanguage();
    });
    queryRow.appendChild(languageSelect);
    var queryInput = el('textarea', 'gejq-query-input');
    queryInput.rows = 2;
    queryInput.placeholder = LANGUAGES.jmespath.placeholder;
    queryInput.spellcheck = false;
    queryInput.addEventListener('input', function () {
      state.query = queryInput.value;
      storageSet(STORAGE_KEY_QUERY, queryInput.value);
      scheduleRun();
    });
    queryInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        runQuery();
        recordQuery();
      }
    });
    queryInput.addEventListener('blur', function () {
      recordQuery();
    });
    queryRow.appendChild(queryInput);
    panel.appendChild(queryRow);

    var error = el('div', 'gejq-error');
    panel.appendChild(error);

    var meta = el('div', 'gejq-meta');
    panel.appendChild(meta);

    // Bottom half of the split: the query result.
    var resultOutput = el('div', 'gejq-result');
    panel.appendChild(resultOutput);

    var suggestions = el('div', 'gejq-suggestions');
    panel.appendChild(suggestions);

    // Query history (persisted, newest first)
    var queryHistoryDetails = el('details', 'gejq-help');
    var queryHistorySummary = el('summary', null, 'Query history');
    queryHistoryDetails.appendChild(queryHistorySummary);
    var queryHistoryBody = el('div', 'gejq-help-body');
    var queryHistoryList = el('div', 'gejq-query-history');
    queryHistoryBody.appendChild(queryHistoryList);
    queryHistoryBody.appendChild(
      button('gejq-icon-button', 'Clear history', 'Delete all saved queries', clearQueryHistory)
    );
    queryHistoryDetails.appendChild(queryHistoryBody);
    panel.appendChild(queryHistoryDetails);

    // Cheat sheet for the selected language
    var helpDetails = el('details', 'gejq-help');
    var helpSummary = el('summary', null, 'Cheat sheet');
    helpDetails.appendChild(helpSummary);
    var helpBody = el('div', 'gejq-help-body');
    helpDetails.appendChild(helpBody);
    panel.appendChild(helpDetails);

    var footer = el('footer', 'gejq-footer');

    // Format switch: Copy and Download follow the selected format.
    var formatSwitch = el('div', 'gejq-seg');
    formatSwitch.setAttribute('role', 'group');
    formatSwitch.setAttribute('aria-label', 'Export format');
    var jsonToggle = button('gejq-seg-btn', 'JSON', 'Export as JSON', function () {
      setFormat('json');
    });
    var csvToggle = button('gejq-seg-btn', 'CSV', 'Export as CSV', function () {
      setFormat('csv');
    });
    formatSwitch.appendChild(jsonToggle);
    formatSwitch.appendChild(csvToggle);
    footer.appendChild(formatSwitch);

    var copyButton = button('gejq-action', 'Copy', 'Copy the query result in the selected format', function () {
      var payload = exportPayload();
      if (payload !== null) {
        copyText(payload.text, copyButton, 'Copied ✓');
      }
    });
    var downloadButton = button('gejq-action', 'Download', 'Download the query result in the selected format', function () {
      var payload = exportPayload();
      if (payload !== null) {
        downloadText(payload.text, payload.filename, payload.mime);
      }
    });
    footer.appendChild(copyButton);
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
      fab: fab,
      fabBadge: fabBadge,
      panel: panel,
      historySelect: historySelect,
      queryInput: queryInput,
      error: error,
      meta: meta,
      resultOutput: resultOutput,
      suggestions: suggestions,
      languageSelect: languageSelect,
      helpSummary: helpSummary,
      helpBody: helpBody,
      queryHistoryList: queryHistoryList,
      queryHistorySummary: queryHistorySummary,
      copyButton: copyButton,
      downloadButton: downloadButton,
      jsonToggle: jsonToggle,
      csvToggle: csvToggle,
      pasteOverlay: pasteOverlay,
      pasteInput: pasteInput,
      pasteError: pasteError
    };

    refreshHistorySelect();
    updateBadge();
    updateExportButtons();
    ensurePlacement();
    renderQueryHistory();
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
    if (!data || data.source !== MESSAGE_SOURCE || data.type !== 'graph-response') {
      return;
    }
    var payload = data.payload;
    if (!payload || typeof payload.id !== 'string' || typeof payload.url !== 'string') {
      return;
    }
    if (payload.json === undefined && !payload.tooLarge) {
      return;
    }
    addResponse({
      id: payload.id,
      method: typeof payload.method === 'string' ? payload.method : 'GET',
      url: payload.url,
      status: typeof payload.status === 'number' ? payload.status : 0,
      timestamp: typeof payload.timestamp === 'number' ? payload.timestamp : Date.now(),
      json: payload.json,
      size: typeof payload.size === 'number' ? payload.size : 0,
      pages: typeof payload.pages === 'number' ? payload.pages : 0,
      tooLarge: payload.tooLarge === true
    });
  });

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
          [STORAGE_KEY_QUERY, STORAGE_KEY_COLLAPSED, STORAGE_KEY_FORMAT, STORAGE_KEY_SETTINGS, STORAGE_KEY_QUERY_HISTORY],
          function (items) {
            state.collapsedPref = items[STORAGE_KEY_COLLAPSED] === true;
            state.format = items[STORAGE_KEY_FORMAT] === 'csv' ? 'csv' : 'json';
            state.settings = normalizeSettings(items[STORAGE_KEY_SETTINGS]);
            state.queryHistory = Array.isArray(items[STORAGE_KEY_QUERY_HISTORY])
              ? items[STORAGE_KEY_QUERY_HISTORY]
              : [];
            buildUi(css);
            var savedQuery = items[STORAGE_KEY_QUERY];
            if (savedQuery && state.query === '') {
              state.query = savedQuery;
              ui.queryInput.value = savedQuery;
            }
            pushSettingsToPage();
            maybeAutoSignIn();
          }
        );
      });

    try {
      chrome.storage.onChanged.addListener(function (changes, areaName) {
        if (areaName !== 'local' || !changes[STORAGE_KEY_SETTINGS]) {
          return;
        }
        var previousLanguage = state.settings.queryLanguage;
        state.settings = normalizeSettings(changes[STORAGE_KEY_SETTINGS].newValue);
        pushSettingsToPage();
        // A lowered history limit trims the stored history right away.
        var limit = state.settings.historyLimit;
        if (limit > 0 && state.queryHistory.length > limit) {
          state.queryHistory = GEJQ.trimHistory(state.queryHistory, limit);
          storageSet(STORAGE_KEY_QUERY_HISTORY, state.queryHistory);
          if (ui) {
            renderQueryHistory();
          }
        }
        if (ui && state.settings.queryLanguage !== previousLanguage) {
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
