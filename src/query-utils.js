/**
 * Graph Explorer JSON Query — pure helper functions.
 *
 * UMD-style so the same file is loaded as a content script (attaches to
 * the global as `GEJQ`) and required from Node for unit tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.GEJQ = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

  /** Clamp to an integer in [min, max]; `fallback` when not a usable number. */
  function clampInt(value, min, max, fallback) {
    var parsed = typeof value === 'string' ? parseInt(value, 10) : value;
    if (typeof parsed === 'number' && isFinite(parsed) && parsed >= min) {
      return Math.min(Math.floor(parsed), max);
    }
    return fallback;
  }

  /** Quote a JSON key so it is a valid JMESPath identifier. */
  function jmesKey(key) {
    if (PLAIN_IDENTIFIER.test(key)) {
      return key;
    }
    return '"' + String(key).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }

  function safeJsonParse(text) {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }

  /** Human description of a query result, e.g. "array · 25 items". */
  function describeResult(value) {
    if (value === null) {
      return 'null';
    }
    if (Array.isArray(value)) {
      return 'array · ' + value.length + (value.length === 1 ? ' item' : ' items');
    }
    switch (typeof value) {
      case 'object':
        var n = Object.keys(value).length;
        return 'object · ' + n + (n === 1 ? ' key' : ' keys');
      case 'string':
        return 'string · ' + value.length + (value.length === 1 ? ' char' : ' chars');
      case 'number':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'undefined':
        return 'no result';
      default:
        return typeof value;
    }
  }

  function formatBytes(bytes) {
    if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) {
      return '';
    }
    if (bytes < 1024) {
      return bytes + ' B';
    }
    var units = ['KB', 'MB', 'GB'];
    var value = bytes;
    var unit = '';
    for (var i = 0; i < units.length; i++) {
      value = value / 1024;
      unit = units[i];
      if (value < 1024) {
        break;
      }
    }
    return (value >= 100 ? Math.round(value) : Math.round(value * 10) / 10) + ' ' + unit;
  }

  /** Compact display form of a Graph URL: path + query, origin stripped. */
  function summarizeUrl(url, maxLength) {
    var max = maxLength || 80;
    var display = String(url || '');
    try {
      var u = new URL(display);
      display = u.pathname + u.search;
    } catch (e) {
      /* keep raw string */
    }
    try {
      display = decodeURIComponent(display);
    } catch (e) {
      /* keep encoded form */
    }
    if (display.length > max) {
      display = display.slice(0, max - 1) + '…';
    }
    return display;
  }

  /** Keep the newest `max` entries (entries are ordered newest-first). */
  function trimHistory(entries, max) {
    if (!Array.isArray(entries)) {
      return [];
    }
    if (entries.length <= max) {
      return entries;
    }
    return entries.slice(0, max);
  }

  /** JSONPath accessor for a key: `.key` or bracket-quoted. */
  function jsonPathKey(key) {
    if (PLAIN_IDENTIFIER.test(key)) {
      return '.' + key;
    }
    return "['" + String(key).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "']";
  }

  /** Pick up to two representative item keys from a collection response. */
  function pickItemKeys(json) {
    var first = null;
    for (var i = 0; i < json.value.length; i++) {
      var item = json.value[i];
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        first = item;
        break;
      }
    }
    if (!first) {
      return { first: null, picked: [] };
    }
    var keys = Object.keys(first);
    var preferred = ['displayName', 'name', 'subject', 'mail', 'userPrincipalName', 'id'];
    var picked = [];
    for (var p = 0; p < preferred.length && picked.length < 2; p++) {
      if (keys.indexOf(preferred[p]) !== -1) {
        picked.push(preferred[p]);
      }
    }
    for (var k = 0; k < keys.length && picked.length < 2; k++) {
      var key = keys[k];
      if (picked.indexOf(key) === -1 && key.indexOf('@') === -1) {
        picked.push(key);
      }
    }
    return { first: first, picked: picked };
  }

  function suggestJmesPathQueries(json) {
    var out = [];
    if (Array.isArray(json)) {
      out.push('[]');
      out.push('length(@)');
      return out;
    }
    if (json === null || typeof json !== 'object') {
      return out;
    }
    if (Array.isArray(json.value)) {
      var pick = pickItemKeys(json);
      var picked = pick.picked;
      for (var s = 0; s < picked.length; s++) {
        out.push('value[].' + jmesKey(picked[s]));
      }
      if (picked.length >= 2) {
        out.push(
          'value[].{' + picked[0].replace(/[^A-Za-z0-9_]/g, '_') + ': ' + jmesKey(picked[0]) +
          ', ' + picked[1].replace(/[^A-Za-z0-9_]/g, '_') + ': ' + jmesKey(picked[1]) + '}'
        );
      }
      if (picked.length >= 1 && pick.first && typeof pick.first[picked[0]] === 'string') {
        out.push('value[?contains(' + jmesKey(picked[0]) + ", 'a')]");
        out.push('sort_by(value, &' + jmesKey(picked[0]) + ')[].' + jmesKey(picked[0]));
      }
      out.push('length(value)');
      if (typeof json['@odata.nextLink'] === 'string') {
        out.push('"@odata.nextLink"');
      }
      return out;
    }
    var topKeys = Object.keys(json).filter(function (key) {
      return key.indexOf('@odata') !== 0;
    });
    for (var t = 0; t < topKeys.length && t < 3; t++) {
      out.push(jmesKey(topKeys[t]));
    }
    out.push('keys(@)');
    return out;
  }

  function suggestJsonPathQueries(json) {
    var out = [];
    if (Array.isArray(json)) {
      out.push('$[*]');
      out.push('$.length');
      return out;
    }
    if (json === null || typeof json !== 'object') {
      return out;
    }
    if (Array.isArray(json.value)) {
      var picked = pickItemKeys(json).picked;
      for (var s = 0; s < picked.length; s++) {
        out.push('$.value[*]' + jsonPathKey(picked[s]));
      }
      if (picked.length >= 1) {
        out.push('$.value[?(@' + jsonPathKey(picked[0]) + ')]');
        out.push('$..' + (PLAIN_IDENTIFIER.test(picked[0]) ? picked[0] : jsonPathKey(picked[0]).slice(1)));
      }
      out.push('$.value.length');
      if (typeof json['@odata.nextLink'] === 'string') {
        out.push("$[?(@property === '@odata.nextLink')]");
      }
      return out;
    }
    var topKeys = Object.keys(json).filter(function (key) {
      return key.indexOf('@') === -1;
    });
    for (var t = 0; t < topKeys.length && t < 3; t++) {
      out.push('$' + jsonPathKey(topKeys[t]));
    }
    out.push('$.*');
    return out;
  }

  /**
   * Suggest queries based on the shape of a Graph response, in the given
   * query language ('jmespath' by default, or 'jsonpath').
   * Returns an array of query strings, most useful first.
   */
  function suggestQueries(json, language) {
    if (language === 'jsonpath') {
      return suggestJsonPathQueries(json);
    }
    return suggestJmesPathQueries(json);
  }

  /**
   * Split a Graph API URL into the parts Graph Explorer's deep-link
   * format uses: { graphUrl, version, request }. Returns null when the
   * URL does not look like <cloud host>/<v1.0|beta>/<resource…>.
   */
  function parseGraphRequest(url) {
    var parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return null;
    }
    var segments = parsed.pathname.split('/').filter(function (segment) {
      return segment !== '';
    });
    if (segments.length === 0 || !/^(v1\.0|beta)$/i.test(segments[0])) {
      return null;
    }
    var request = segments.slice(1).join('/') + parsed.search;
    if (request === '') {
      return null;
    }
    return {
      graphUrl: parsed.origin,
      version: segments[0],
      request: request
    };
  }

  /**
   * Build a Graph Explorer deep link (the same format its own
   * "Share query" feature produces) that pre-fills method, version and
   * resource URL on load. `pageBase` is the Graph Explorer page URL
   * without query string. Returns null for URLs parseGraphRequest
   * cannot handle.
   */
  function buildDeepLink(pageBase, method, url) {
    var parts = parseGraphRequest(url);
    if (!parts) {
      return null;
    }
    return (
      pageBase +
      '?request=' + encodeURIComponent(parts.request) +
      '&method=' + encodeURIComponent(String(method || 'GET').toUpperCase()) +
      '&version=' + encodeURIComponent(parts.version) +
      '&GraphUrl=' + encodeURIComponent(parts.graphUrl)
    );
  }

  /**
   * Insert an executed query into the query history (newest first).
   * Entries are unique per (language, query): re-running a query moves it
   * to the top, bumps `uses`, and refreshes `lastUsed`/`context`.
   * `limit` caps the list length; 0 (or null) means unlimited.
   */
  function upsertQueryHistory(list, entry, limit) {
    var out = [];
    var existing = null;
    (Array.isArray(list) ? list : []).forEach(function (item) {
      if (item && item.query === entry.query && item.language === entry.language) {
        existing = item;
      } else if (item) {
        out.push(item);
      }
    });
    out.unshift({
      query: entry.query,
      language: entry.language,
      lastUsed: entry.lastUsed,
      uses: ((existing && existing.uses) || 0) + 1,
      context: entry.context || (existing && existing.context) || null
    });
    if (limit && limit > 0 && out.length > limit) {
      out = out.slice(0, limit);
    }
    return out;
  }

  /** "14:32:05" for today, "2026-08-06 14:32" for older timestamps. */
  function formatTimestamp(timestamp, now) {
    var time = new Date(timestamp);
    var reference = now === undefined ? new Date() : new Date(now);
    var pad = function (n) {
      return (n < 10 ? '0' : '') + n;
    };
    var clock = pad(time.getHours()) + ':' + pad(time.getMinutes());
    if (
      time.getFullYear() === reference.getFullYear() &&
      time.getMonth() === reference.getMonth() &&
      time.getDate() === reference.getDate()
    ) {
      return clock + ':' + pad(time.getSeconds());
    }
    return time.getFullYear() + '-' + pad(time.getMonth() + 1) + '-' + pad(time.getDate()) + ' ' + clock;
  }

  /**
   * Microsoft Graph "advanced queries" against directory objects require
   * the `ConsistencyLevel: eventual` header together with `$count=true`
   * (see https://learn.microsoft.com/graph/aad-advanced-queries).
   *
   * Given an outgoing request, decide whether to opt it into advanced
   * query mode: GET requests using $filter, $search, $orderby, or $count
   * get `$count=true` appended (when missing) and the header added.
   * Everything else passes through untouched.
   *
   * Returns { url, addHeader } — url is possibly rewritten.
   */
  function applyAdvancedQuery(url, method) {
    var unchanged = { url: url, addHeader: false };
    if (String(method || 'GET').toUpperCase() !== 'GET') {
      return unchanged;
    }
    var parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return unchanged;
    }
    // `GET /users/$count` style requests also need the header.
    if (/\/\$count$/i.test(parsed.pathname)) {
      return { url: url, addHeader: true };
    }
    var hasTrigger = false;
    var hasCount = false;
    parsed.searchParams.forEach(function (paramValue, paramName) {
      var name = paramName.toLowerCase();
      if (name === '$filter' || name === '$search' || name === '$orderby') {
        hasTrigger = true;
      }
      if (name === '$count') {
        hasCount = true;
      }
    });
    if (!hasTrigger && !hasCount) {
      return unchanged;
    }
    if (!hasCount) {
      parsed.searchParams.append('$count', 'true');
    }
    return { url: parsed.href, addHeader: true };
  }

  /**
   * How a value can be represented as CSV: 'objects' (array of flat
   * objects), 'scalars' (array of primitives), or null (not CSV-able).
   */
  function csvShape(value) {
    if (!Array.isArray(value) || value.length === 0) {
      return null;
    }
    var allObjects = value.every(function (row) {
      return row !== null && typeof row === 'object' && !Array.isArray(row);
    });
    if (allObjects) {
      var hasColumns = value.some(function (row) {
        return Object.keys(row).length > 0;
      });
      return hasColumns ? 'objects' : null;
    }
    var allScalars = value.every(function (row) {
      return row === null || typeof row !== 'object';
    });
    return allScalars ? 'scalars' : null;
  }

  /** Cheap check (no string building) used to enable/disable CSV export. */
  function csvEligible(value) {
    return csvShape(value) !== null;
  }

  /**
   * Convert a query result to CSV. Supports arrays of flat objects
   * (nested values are JSON-encoded into the cell) and arrays of scalars.
   * Returns null when the value has no sensible CSV representation.
   */
  function toCsv(value) {
    var shape = csvShape(value);
    if (shape === null) {
      return null;
    }

    function escapeCell(cell) {
      if (cell === null || cell === undefined) {
        return '';
      }
      var text;
      if (typeof cell === 'object') {
        text = JSON.stringify(cell);
      } else {
        text = String(cell);
      }
      if (/[",\n\r]/.test(text)) {
        text = '"' + text.replace(/"/g, '""') + '"';
      }
      return text;
    }

    var lines = [];
    if (shape === 'objects') {
      var columns = [];
      value.forEach(function (row) {
        Object.keys(row).forEach(function (key) {
          if (columns.indexOf(key) === -1) {
            columns.push(key);
          }
        });
      });
      lines.push(columns.map(escapeCell).join(','));
      value.forEach(function (row) {
        lines.push(
          columns
            .map(function (column) {
              return escapeCell(row[column]);
            })
            .join(',')
        );
      });
      return lines.join('\r\n');
    }

    lines.push('value');
    value.forEach(function (row) {
      lines.push(escapeCell(row));
    });
    return lines.join('\r\n');
  }

  /**
   * File name for an exported result: derived from the Graph request's
   * resource path plus a local timestamp, e.g.
   * "graph-users-messages-2026-08-08-093005.csv". Falls back to
   * "graph-query-…" when the source URL is not a real URL (pasted JSON).
   * `now` is injectable for tests.
   */
  function exportFilename(url, extension, now) {
    var base = 'graph-query';
    try {
      var segments = new URL(url).pathname
        .split('/')
        .filter(function (segment) {
          return segment !== '' && !/^(v1\.0|beta)$/i.test(segment);
        })
        .slice(-2)
        .map(function (segment) {
          return decodeURIComponent(segment).toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
        })
        .filter(function (segment) {
          return segment !== '';
        });
      if (segments.length > 0) {
        base = 'graph-' + segments.join('-');
      }
    } catch (e) {
      /* not a URL — keep the fallback base */
    }
    var time = new Date(now === undefined ? Date.now() : now);
    var pad = function (n) {
      return (n < 10 ? '0' : '') + n;
    };
    var stamp =
      time.getFullYear() + '-' + pad(time.getMonth() + 1) + '-' + pad(time.getDate()) +
      '-' + pad(time.getHours()) + pad(time.getMinutes()) + pad(time.getSeconds());
    return base + '-' + stamp + '.' + extension;
  }

  return {
    jmesKey: jmesKey,
    jsonPathKey: jsonPathKey,
    clampInt: clampInt,
    applyAdvancedQuery: applyAdvancedQuery,
    parseGraphRequest: parseGraphRequest,
    buildDeepLink: buildDeepLink,
    upsertQueryHistory: upsertQueryHistory,
    formatTimestamp: formatTimestamp,
    csvEligible: csvEligible,
    exportFilename: exportFilename,
    safeJsonParse: safeJsonParse,
    describeResult: describeResult,
    formatBytes: formatBytes,
    summarizeUrl: summarizeUrl,
    trimHistory: trimHistory,
    suggestQueries: suggestQueries,
    toCsv: toCsv
  };
});
