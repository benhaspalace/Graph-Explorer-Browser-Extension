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
  var STORAGE_KEY_SPLIT = 'gejq.splitPct';
  var STORAGE_KEY_SHOW_BG = 'gejq.showBackground';
  var STORAGE_KEY_SETTINGS = 'gejq.settings';
  var STORAGE_KEY_QUERY_HISTORY = 'gejq.queryHistory';
  var AUTO_SIGNIN_GUARD = 'gejq.autoSignInAttempted';
  var DEFAULT_SETTINGS = Object.freeze({
    advancedQuery: true,
    autoSignIn: true,
    autoFetchNextLink: false,
    autoFetchMaxPages: 50,
    autoFetchMaxMb: 10,
    queryLanguage: 'jmespath',
    historyLimit: 50 // 0 = unlimited
  });
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
    format: 'json', // export format: 'json' | 'csv'
    splitPct: 50, // width of the embedded panel as % of the results area
    showBackground: false, // show Graph Explorer's own background requests
    settings: normalizeSettings(null), // fresh mutable copy of the defaults
    queryHistory: [] // executed queries, newest first (persisted)
  };

  var ui = null; // populated by buildUi()
  var runTimer = null;
  var embedTimer = null;
  var manualCounter = 0;
  var lastRunInteraction = 0; // when the user last ran a query in Graph Explorer
  var autocomplete = { open: false, result: null, activeIndex: 0 }; // query-input completion state

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

  /**
   * Render the query result in the result area. In CSV export mode the
   * output view shows the CSV text itself (when the result is CSV-able);
   * otherwise pretty-printed JSON. Returns 'csv' or 'json' accordingly.
   */
  function renderResult(value) {
    var output = ui.resultOutput;
    clearChildren(output);
    if (value === undefined) {
      output.appendChild(el('div', 'gejq-empty', 'The query returned no result (undefined).'));
      return 'json';
    }
    var mode = 'json';
    var text = null;
    if (state.format === 'csv') {
      text = GEJQ.toCsv(value);
      if (text !== null) {
        mode = 'csv';
      }
    }
    if (mode === 'json') {
      text = JSON.stringify(value, null, 2);
      if (typeof text !== 'string') {
        text = String(value);
      }
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
      return mode;
    }
    var pre = el('pre', 'gejq-json');
    if (mode === 'csv' || text.length > HIGHLIGHT_LIMIT) {
      pre.textContent = text;
    } else {
      appendHighlightedJson(pre, text);
    }
    output.appendChild(pre);
    return mode;
  }

  // ------------------------------------------------------------ query logic

  /** Responses shown in the panel (background ones only when toggled on). */
  function visibleResponses() {
    if (state.showBackground) {
      return state.responses;
    }
    return state.responses.filter(function (entry) {
      return !entry.background;
    });
  }

  function selectedResponse() {
    var list = visibleResponses();
    if (list.length === 0) {
      return null;
    }
    if (state.followLatest || state.selectedId === null) {
      return list[0];
    }
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === state.selectedId) {
        return list[i];
      }
    }
    return list[0];
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
      return { value: undefined, error: e && e.message ? e.message : String(e) };
    }
  }

  /**
   * Show the full request line of the selected response — selectable
   * text, unlike the truncated labels inside the <select> — plus a badge
   * saying whether the query follows the live (latest) response or is
   * pinned to an older one.
   */
  function updateResponseInfo(response) {
    clearChildren(ui.responseInfo);
    if (!response) {
      return;
    }
    var live = state.followLatest;
    var badge = el('span', 'gejq-live-badge' + (live ? ' gejq-live' : ''), live ? '● live' : 'pinned');
    badge.title = live
      ? 'Following the latest response: the query re-runs automatically whenever a new Graph query executes'
      : 'Pinned to this response — pick the newest entry in the list above to follow new responses again';
    ui.responseInfo.appendChild(badge);
    ui.responseInfo.appendChild(
      el('span', 'gejq-response-url', response.method + ' ' + response.url + (response.manual ? '' : ' → ' + response.status))
    );
  }

  function runQuery() {
    var response = selectedResponse();
    updateResponseInfo(response);

    if (!response) {
      ui.error.textContent = '';
      ui.warning.textContent = '';
      ui.meta.textContent = '';
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
      return;
    }

    if (response.tooLarge) {
      ui.error.textContent = '';
      ui.warning.textContent = '';
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

    ui.warning.textContent = response.truncated
      ? '⚠ Auto-fetch stopped early: only ' + response.pages + ' pages (' + GEJQ.formatBytes(response.size) + ') were fetched before hitting the configured limit — this dataset is incomplete. Raise the auto-fetch limits in the extension settings to fetch more.'
      : '';

    // Suggestions depend on the response and language, not on the query —
    // refresh them even when the current query errors (e.g. right after
    // a language switch left an incompatible query in the box).
    renderSuggestions(response.json);

    var outcome = currentResult();
    if (outcome.error) {
      ui.error.textContent = outcome.error;
      updateExportButtons(outcome);
      return; // keep previous result visible while the user types
    }
    ui.error.textContent = '';
    var viewMode = renderResult(outcome.value);
    ui.meta.textContent = GEJQ.describeResult(outcome.value) + (viewMode === 'csv' ? ' · CSV view' : '');
    updateExportButtons(outcome);
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
    var response = selectedResponse();
    var sourceUrl = response ? response.url : '';
    if (state.format === 'csv') {
      var csv = GEJQ.toCsv(outcome.value);
      if (csv === null) {
        return null;
      }
      return { text: csv, filename: GEJQ.exportFilename(sourceUrl, 'csv'), mime: 'text/csv' };
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
      outcome = currentResult();
    }
    var hasResult = !outcome.error && outcome.value !== undefined;
    var csvOk = hasResult && GEJQ.csvEligible(outcome.value);
    ui.csvToggle.disabled = !csvOk;
    ui.csvToggle.title = hasResult && !csvOk
      ? 'This result cannot be represented as CSV (needs an array of objects or scalar values)'
      : 'Export as CSV';
    ui.jsonToggle.classList.toggle('gejq-seg-active', state.format === 'json');
    ui.csvToggle.classList.toggle('gejq-seg-active', state.format === 'csv');
    ui.jsonToggle.setAttribute('aria-pressed', state.format === 'json' ? 'true' : 'false');
    ui.csvToggle.setAttribute('aria-pressed', state.format === 'csv' ? 'true' : 'false');
    var exportable = hasResult && (state.format === 'json' || csvOk);
    ui.copyButton.disabled = !exportable;
    ui.downloadButton.disabled = !exportable;
  }

  function setFormat(format) {
    state.format = format;
    storageSet(STORAGE_KEY_FORMAT, format);
    runQuery(); // re-render: the output view follows the selected format
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
      autoFetchMaxPages: GEJQ.clampInt(raw && raw.autoFetchMaxPages, 1, 1000, DEFAULT_SETTINGS.autoFetchMaxPages),
      autoFetchMaxMb: GEJQ.clampInt(raw && raw.autoFetchMaxMb, 1, 50, DEFAULT_SETTINGS.autoFetchMaxMb),
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

  /** Re-apply everything that depends on the selected query language. */
  function applyLanguage() {
    var language = LANGUAGES[state.settings.queryLanguage];
    closeAutocomplete();
    ui.titleLabel.textContent = 'JSON Query (' + language.label + ')';
    ui.queryInput.placeholder = language.placeholder;
    if (ui.languageSelect.value !== state.settings.queryLanguage) {
      ui.languageSelect.value = state.settings.queryLanguage;
    }
    rebuildHelp();
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
      ui.queryInput.value = converted.query;
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
      status += ' · ' + entry.pages + ' pages' + (entry.truncated ? ', incomplete' : '');
    }
    return (
      (entry.background ? '⚙ ' : '') +
      GEJQ.formatTimestamp(entry.timestamp) +
      ' · ' + entry.method + ' ' + GEJQ.summarizeUrl(entry.url, 60) + ' (' + status + ')'
    );
  }

  function backgroundCount() {
    return state.responses.filter(function (entry) {
      return entry.background;
    }).length;
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

    // Toggle for Graph Explorer's own background requests.
    var hidden = backgroundCount();
    ui.backgroundToggle.style.display = hidden > 0 ? '' : 'none';
    ui.backgroundToggle.textContent = '⚙ ' + hidden;
    ui.backgroundToggle.classList.toggle('gejq-seg-active', state.showBackground);
    ui.backgroundToggle.setAttribute('aria-pressed', state.showBackground ? 'true' : 'false');
    ui.backgroundToggle.title = state.showBackground
      ? 'Hide Graph Explorer’s own background requests (profile, organization, permissions)'
      : hidden + ' background request(s) from Graph Explorer itself are hidden — click to show them';
  }

  function addResponse(entry) {
    state.responses.unshift(entry);
    state.responses = GEJQ.trimHistory(state.responses, MAX_HISTORY);
    var visible = !entry.background || state.showBackground;
    if (state.followLatest && visible) {
      state.selectedId = entry.id;
    }
    if (ui) {
      refreshHistorySelect();
      updateBadge();
      if (visible) {
        pulseFab();
        if (state.open && state.followLatest) {
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
    // Leaving the URI field (including via a click on Run, which blurs
    // it first) is the moment to apply visible advanced-query help.
    document.addEventListener(
      'blur',
      function (event) {
        if (event.target === findEditorInput()) {
          maybeAssistAdvancedQuery();
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
    var input = ui.queryInput;
    var caret = input.selectionStart;
    if (caret === null || caret !== input.selectionEnd) {
      closeAutocomplete();
      return;
    }
    var result = GEJQ.queryCompletions(state.settings.queryLanguage, input.value.slice(0, caret));
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
    var input = ui.queryInput;
    var caret = input.selectionStart;
    var before = input.value.slice(0, autocomplete.result.replaceFrom);
    var after = input.value.slice(caret);
    input.value = before + item.insert + after;
    var newCaret = before.length + item.insert.length;
    input.setSelectionRange(newCaret, newCaret);
    state.query = input.value;
    storageSet(STORAGE_KEY_QUERY, input.value);
    closeAutocomplete();
    scheduleRun();
    input.focus();
  }

  // ------------------------------------------------ advanced query assist

  var HEADER_ADDED_GUARD_PREFIX = 'gejq.headerAdded.';

  /**
   * Visible advanced-query assistance: when the URI field holds a GET
   * query using $filter/$search/$orderby (or $count), append $count=true
   * to the field itself and add `ConsistencyLevel: eventual` plus
   * `Content-Type: application/json` rows via Graph Explorer's own
   * Request-headers view. Nothing is modified behind the user's back —
   * every change is visible in the query view before the request runs.
   * Triggered when the URI field loses focus. Body-carrying methods
   * (POST/PUT/PATCH) get the Content-Type row even without advanced
   * query options.
   */
  function maybeAssistAdvancedQuery() {
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
    var rows = [];
    if (advanced.addHeader) {
      if (!/[?&]\$count=/i.test(input.value)) {
        // Append as text so the user's own formatting stays intact.
        setNativeInputValue(input, input.value + (input.value.indexOf('?') === -1 ? '?' : '&') + '$count=true');
      }
      rows.push({ name: 'ConsistencyLevel', value: 'eventual' });
    }
    if (advanced.addHeader || method === 'POST' || method === 'PUT' || method === 'PATCH') {
      rows.push({ name: 'Content-Type', value: 'application/json' });
    }
    if (rows.length > 0) {
      ensureHeaderRows(rows);
    }
  }

  /**
   * Add header rows through Graph Explorer's Request-headers tab so they
   * are visible (and persisted by GE) exactly like hand-entered ones.
   * Best effort: silently does nothing when the tab or its inputs can't
   * be found; each header is attempted at most once per tab session.
   */
  function ensureHeaderRows(rows) {
    var pending = rows.filter(function (row) {
      try {
        return !sessionStorage.getItem(HEADER_ADDED_GUARD_PREFIX + row.name);
      } catch (e) {
        return true;
      }
    });
    if (pending.length === 0) {
      return;
    }
    var headersTab = document.getElementById('request-headers');
    if (!headersTab) {
      return;
    }
    var previousTab = document.querySelector('[role="tab"][aria-selected="true"]');
    var restoreTab = previousTab && previousTab !== headersTab ? previousTab : null;
    headersTab.click();

    function finish() {
      if (restoreTab) {
        try {
          restoreTab.click();
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
      try {
        var row = pending[index];
        var nameInput = document.querySelector('input[name="name"]');
        var valueInput = document.querySelector('input[name="value"]');
        if (!nameInput || !valueInput) {
          finish();
          return;
        }
        var panelRoot = nameInput.closest('[role="tabpanel"]') || nameInput.parentElement.parentElement;
        if (panelRoot && panelRoot.textContent.indexOf(row.name) !== -1) {
          markHeaderAdded(row.name); // already present
          addNext(index + 1);
          return;
        }
        setNativeInputValue(nameInput, row.name);
        setNativeInputValue(valueInput, row.value);
        var addButton = findAddButton(panelRoot || document);
        if (!addButton) {
          finish();
          return;
        }
        addButton.click();
        markHeaderAdded(row.name);
        setTimeout(function () {
          addNext(index + 1);
        }, 120);
      } catch (e) {
        finish(); // never break Graph Explorer
      }
    }

    setTimeout(function () {
      addNext(0);
    }, 150);
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
   * Re-populate Graph Explorer's request editor with a saved method +
   * URL. When the editor's current method already matches, the URL is
   * written straight into the request input (no reload). Otherwise it
   * falls back to Graph Explorer's own deep-link format — the same
   * mechanism its "Share query" and history links use — which reloads
   * the page with method, version, and resource pre-filled.
   */
  function populateGraphExplorer(method, url) {
    method = String(method || 'GET').toUpperCase();
    var input = findEditorInput();
    var methodControl = document.querySelector('[aria-label="HTTP request method option" i]');
    var currentMethod = methodControl && methodControl.textContent
      ? methodControl.textContent.trim().toUpperCase()
      : null;
    if (input && currentMethod === method) {
      setNativeInputValue(input, url);
      input.focus();
      return true;
    }
    var link = GEJQ.buildDeepLink(window.location.origin + window.location.pathname, method, url);
    if (link) {
      window.location.assign(link);
      return true;
    }
    return false;
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
    function commit() {
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
        renderQueryHistory(); // cancel
      }
    });
    input.addEventListener('blur', commit);
    row.replaceChild(input, metaLabel);
    input.focus();
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

    row.appendChild(
      button('gejq-chip', item.query, 'Use this query', function () {
        if (LANGUAGES[item.language] && state.settings.queryLanguage !== item.language) {
          // Saved queries are already in their own language — switch
          // without attempting a conversion.
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
    if (Array.isArray(item.tags) && item.tags.length > 0) {
      metaText += ' · #' + item.tags.join(' #');
    }
    var metaLabel = el('span', 'gejq-example-label', metaText);
    row.appendChild(metaLabel);

    row.appendChild(
      button('gejq-icon-mini', '🏷', 'Edit tags (comma separated)', function () {
        editTags(item, row, metaLabel);
      })
    );

    if (item.context && item.context.url && GEJQ.parseGraphRequest(item.context.url)) {
      row.appendChild(
        button('gejq-chip gejq-load', 'Load ↗', 'Re-populate Graph Explorer with this request (method + URL)', function () {
          populateGraphExplorer(item.context.method, item.context.url);
        })
      );
    }
    return row;
  }

  function renderQueryHistory() {
    var container = ui.queryHistoryList;
    clearChildren(container);
    ui.queryHistorySummary.textContent = 'Query history' + (state.queryHistory.length ? ' (' + state.queryHistory.length + ')' : '');
    if (state.queryHistory.length === 0) {
      container.appendChild(
        el('p', 'gejq-help-text', 'Queries you run (Enter, or clicking a suggestion) are saved here with a timestamp and the Graph request they ran against. Star ★ a query to pin it; tag 🏷 queries to group them.')
      );
      return;
    }
    var groups = GEJQ.groupQueryHistory(state.queryHistory);
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
    var titleLabel = el('span', null, 'JSON Query'); // suffixed by applyLanguage()
    title.appendChild(titleLabel);
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

    var historyRow = el('div', 'gejq-history-row');
    var historySelect = el('select', 'gejq-history-select');
    historySelect.title = 'Captured Graph responses (newest first)';
    historySelect.addEventListener('change', function () {
      state.selectedId = historySelect.value;
      var visible = visibleResponses();
      state.followLatest = visible.length > 0 && visible[0].id === historySelect.value;
      runQuery();
    });
    historyRow.appendChild(historySelect);
    var backgroundToggle = button('gejq-bg-toggle', '⚙ 0', '', function () {
      state.showBackground = !state.showBackground;
      storageSet(STORAGE_KEY_SHOW_BG, state.showBackground);
      refreshHistorySelect();
      updateBadge();
      runQuery();
    });
    backgroundToggle.style.display = 'none';
    historyRow.appendChild(backgroundToggle);
    panel.appendChild(historyRow);

    // Full request line of the selected response: selectable, with a
    // live/pinned indicator.
    var responseInfo = el('div', 'gejq-response-info');
    panel.appendChild(responseInfo);

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
    var queryInput = el('textarea', 'gejq-query-input');
    queryInput.rows = 2;
    queryInput.spellcheck = false; // placeholder is set by applyLanguage()
    queryInput.addEventListener('input', function () {
      state.query = queryInput.value;
      storageSet(STORAGE_KEY_QUERY, queryInput.value);
      scheduleRun();
      updateAutocomplete();
    });
    // Recording happens only on deliberate runs (Enter or chip clicks) —
    // a blur handler would capture half-typed queries when the focus
    // moves to a suggestion chip.
    queryInput.addEventListener('keydown', function (event) {
      if (autocomplete.open) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          moveAutocomplete(event.key === 'ArrowDown' ? 1 : -1);
          return;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          acceptCompletion(autocomplete.result.items[autocomplete.activeIndex]);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation(); // don't collapse the panel
          closeAutocomplete();
          return;
        }
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        runQuery();
        recordQuery();
      }
    });
    queryInput.addEventListener('blur', function () {
      // Delayed so a mousedown on a completion row can land first.
      setTimeout(function () {
        closeAutocomplete();
      }, 150);
    });
    var autocompleteList = el('div', 'gejq-autocomplete');
    autocompleteList.style.display = 'none';
    queryWrap.appendChild(queryInput);
    queryWrap.appendChild(autocompleteList);
    queryRow.appendChild(queryWrap);
    panel.appendChild(queryRow);

    var error = el('div', 'gejq-error');
    panel.appendChild(error);

    var warning = el('div', 'gejq-warning');
    panel.appendChild(warning);

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
        // UTF-8 BOM so Excel opens downloaded CSVs with correct accents.
        var text = payload.mime === 'text/csv' ? '\uFEFF' + payload.text : payload.text;
        downloadText(text, payload.filename, payload.mime);
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
      titleLabel: titleLabel,
      historySelect: historySelect,
      backgroundToggle: backgroundToggle,
      responseInfo: responseInfo,
      queryInput: queryInput,
      autocompleteList: autocompleteList,
      error: error,
      warning: warning,
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
    addResponse({
      id: payload.id,
      method: typeof payload.method === 'string' ? payload.method : 'GET',
      url: payload.url,
      status: typeof payload.status === 'number' ? payload.status : 0,
      timestamp: typeof payload.timestamp === 'number' ? payload.timestamp : Date.now(),
      json: payload.json,
      size: typeof payload.size === 'number' ? payload.size : 0,
      pages: pages,
      truncated: payload.truncated === true,
      background: background,
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
          [STORAGE_KEY_QUERY, STORAGE_KEY_COLLAPSED, STORAGE_KEY_FORMAT, STORAGE_KEY_SPLIT, STORAGE_KEY_SHOW_BG, STORAGE_KEY_SETTINGS, STORAGE_KEY_QUERY_HISTORY],
          function (items) {
            state.collapsedPref = items[STORAGE_KEY_COLLAPSED] === true;
            state.format = items[STORAGE_KEY_FORMAT] === 'csv' ? 'csv' : 'json';
            state.splitPct = GEJQ.clampInt(items[STORAGE_KEY_SPLIT], 15, 85, 50);
            state.showBackground = items[STORAGE_KEY_SHOW_BG] === true;
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
            trackRunInteractions();
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
