/**
 * Graph Explorer JSON Query — off-thread query evaluator.
 *
 * Runs inside src/evaluator.html, a hidden extension-origin iframe the
 * content script embeds into Graph Explorer. Chrome hosts
 * chrome-extension:// frames in the extension's own process, so this
 * page has its own main thread: datasets are cached here and every
 * query evaluation, size walk, table sort, export serialization, and
 * diff over LARGE datasets happens here — the Graph Explorer tab's
 * thread (page, interceptor, panel) never blocks on them. Small
 * datasets keep the panel's synchronous local path for zero latency.
 *
 * Protocol (window.postMessage, structured-clone JSON):
 *   in : { type: 'gejq-dataset',  id, json }
 *   in : { type: 'gejq-evaluate', requestId, datasetId, language, query,
 *          valueLimit, sizeCeiling, sort }
 *   in : { type: 'gejq-export',   requestId, datasetId, language, query,
 *          format: 'json'|'csv'|'tsv', sort }
 *   in : { type: 'gejq-diff',     requestId, baseId, currentId, language,
 *          query }
 *   out: { source: 'gejq-evaluator', type: 'gejq-ready' }
 *   out: { source: 'gejq-evaluator', type: 'gejq-result'|'gejq-export-result'|
 *          'gejq-diff-result', requestId, … }
 *
 * Trust model: anything in the embedding tab (the content script, but
 * also Graph Explorer's own scripts) can post here. That is acceptable
 * because this page only ever runs the three data-query engines over
 * JSON it was handed — no code evaluation, no privileged APIs, no
 * storage — and the panel only trusts replies whose event.source is
 * this exact frame.
 */
(function () {
  'use strict';

  var MAX_DATASETS = 30;
  var TABLE_ROW_LIMIT = 1000;
  var DIFF_LIMIT = 500;
  var DIFF_DETAIL_CHARS = 160;

  var datasets = {}; // id -> { json, gen, touched }
  var generationCounter = 0;
  var touchCounter = 0;
  // One-slot result cache: re-sorting a table or exporting right after an
  // evaluation must not re-run the query.
  var lastEval = { key: null, value: undefined };

  function storeDataset(id, json) {
    generationCounter += 1;
    touchCounter += 1;
    datasets[id] = { json: json, gen: generationCounter, touched: touchCounter };
    if (lastEval.key !== null && lastEval.key.indexOf(id + '|') === 0) {
      lastEval = { key: null, value: undefined };
    }
    var ids = Object.keys(datasets);
    if (ids.length > MAX_DATASETS) {
      ids.sort(function (a, b) {
        return datasets[a].touched - datasets[b].touched;
      });
      for (var i = 0; i < ids.length - MAX_DATASETS; i++) {
        delete datasets[ids[i]];
      }
    }
  }

  function evaluate(language, json, query) {
    if (query === '') {
      return json;
    }
    if (language === 'jsonpath') {
      return JSONPath.JSONPath({ path: query, json: json, wrap: true });
    }
    if (language === 'jq') {
      var jq = JQTS.default || JQTS;
      var outputs = jq.compile(query).evaluate(json);
      return outputs.length === 1 ? outputs[0] : outputs;
    }
    return jmespath.search(json, query);
  }

  /** Evaluate with the one-slot cache (keyed on dataset generation). */
  function evaluateCached(datasetId, language, query) {
    var dataset = datasets[datasetId];
    touchCounter += 1;
    dataset.touched = touchCounter;
    var key = datasetId + '|' + dataset.gen + '|' + language + '|' + query;
    if (lastEval.key === key) {
      return lastEval.value;
    }
    var value = evaluate(language, dataset.json, query.trim());
    lastEval = { key: key, value: value };
    return value;
  }

  function errorText(e) {
    return e && e.message ? e.message : String(e);
  }

  function handleEvaluate(data, reply) {
    var dataset = datasets[data.datasetId];
    if (!dataset) {
      reply({ type: 'gejq-result', requestId: data.requestId, needDataset: true });
      return;
    }
    var value;
    try {
      value = evaluateCached(data.datasetId, data.language, String(data.query || ''));
    } catch (e) {
      reply({ type: 'gejq-result', requestId: data.requestId, ok: false, error: errorText(e) });
      return;
    }
    if (value === undefined) {
      reply({ type: 'gejq-result', requestId: data.requestId, ok: true, valueUndefined: true });
      return;
    }
    var limited = GEJQ.stringifyLimited(value, data.valueLimit, data.sizeCeiling);
    if (!limited.truncated) {
      // Small result: hand the value itself back — the panel then works
      // exactly as it does for local evaluations (tree, pin, diff, …).
      reply({ type: 'gejq-result', requestId: data.requestId, ok: true, value: value, size: limited.length });
      return;
    }
    // Large result: only render-ready artifacts cross the thread boundary.
    reply({
      type: 'gejq-result',
      requestId: data.requestId,
      ok: true,
      large: {
        preview: limited.text,
        size: limited.length,
        overflow: limited.overflow,
        describe: GEJQ.describeResult(value),
        csv: GEJQ.csvPreview(value, data.sort || null, TABLE_ROW_LIMIT)
      }
    });
  }

  function handleExport(data, reply) {
    var dataset = datasets[data.datasetId];
    if (!dataset) {
      reply({ type: 'gejq-export-result', requestId: data.requestId, needDataset: true });
      return;
    }
    try {
      var value = evaluateCached(data.datasetId, data.language, String(data.query || ''));
      var text = null;
      if (data.format === 'csv' || data.format === 'tsv') {
        var rows = value;
        var shape = GEJQ.csvShape(value);
        if (data.sort && data.sort.column !== null && data.sort.column !== undefined && shape !== null) {
          rows = GEJQ.sortRows(value, shape === 'objects' ? data.sort.column : null, data.sort.dir);
        }
        text = data.format === 'tsv' ? GEJQ.toTsv(rows) : GEJQ.toCsv(rows);
      } else {
        text = value === undefined ? null : JSON.stringify(value, null, 2);
      }
      reply({ type: 'gejq-export-result', requestId: data.requestId, ok: text !== null, text: text });
    } catch (e) {
      reply({ type: 'gejq-export-result', requestId: data.requestId, ok: false, error: errorText(e) });
    }
  }

  function handleDiff(data, reply) {
    var base = datasets[data.baseId];
    var current = datasets[data.currentId];
    if (!base || !current) {
      reply({ type: 'gejq-diff-result', requestId: data.requestId, needDataset: true, missing: [!base ? data.baseId : null, !current ? data.currentId : null] });
      return;
    }
    var query = String(data.query || '');
    var currentValue;
    try {
      currentValue = evaluateCached(data.currentId, data.language, query);
    } catch (e) {
      reply({ type: 'gejq-diff-result', requestId: data.requestId, ok: false, error: errorText(e), side: 'current' });
      return;
    }
    var baseValue;
    try {
      baseValue = evaluateCached(data.baseId, data.language, query);
    } catch (e) {
      reply({ type: 'gejq-diff-result', requestId: data.requestId, ok: false, error: errorText(e), side: 'base' });
      return;
    }
    // Rows are pre-rendered to short strings here: raw before/after values
    // could each be megabytes, and the panel only shows a capped detail.
    var rows = GEJQ.diffJson(baseValue, currentValue, DIFF_LIMIT).map(function (diff) {
      var beforeText = diff.before === undefined ? '' : JSON.stringify(diff.before);
      var afterText = diff.after === undefined ? '' : JSON.stringify(diff.after);
      var detail = diff.kind === 'added' ? afterText : diff.kind === 'removed' ? beforeText : beforeText + ' → ' + afterText;
      if (detail.length > DIFF_DETAIL_CHARS) {
        detail = detail.slice(0, DIFF_DETAIL_CHARS) + '…';
      }
      return { path: diff.path, kind: diff.kind, detail: detail };
    });
    reply({ type: 'gejq-diff-result', requestId: data.requestId, ok: true, rows: rows });
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || typeof data.type !== 'string' || !event.source) {
      return;
    }
    var reply = function (payload) {
      payload.source = 'gejq-evaluator';
      event.source.postMessage(payload, event.origin);
    };
    try {
      if (data.type === 'gejq-dataset' && typeof data.id === 'string') {
        storeDataset(data.id, data.json);
      } else if (data.type === 'gejq-evaluate') {
        handleEvaluate(data, reply);
      } else if (data.type === 'gejq-export') {
        handleExport(data, reply);
      } else if (data.type === 'gejq-diff') {
        handleDiff(data, reply);
      }
    } catch (e) {
      if (typeof data.requestId === 'number') {
        reply({ type: 'gejq-result', requestId: data.requestId, ok: false, error: errorText(e) });
      }
    }
  });

  // Tell the embedding content script this page is up (also fires again
  // after a reload, which resets the dataset cache — the panel re-syncs).
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ source: 'gejq-evaluator', type: 'gejq-ready' }, '*');
  }
})();
