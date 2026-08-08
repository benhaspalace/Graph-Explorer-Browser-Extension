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

  function suggestJqQueries(json) {
    var out = [];
    if (Array.isArray(json)) {
      out.push('.[]');
      out.push('length');
      return out;
    }
    if (json === null || typeof json !== 'object') {
      return out;
    }
    if (Array.isArray(json.value)) {
      var picked = pickItemKeys(json).picked;
      for (var s = 0; s < picked.length; s++) {
        out.push('.value[].' + jqKey(picked[s]));
      }
      if (picked.length >= 2) {
        out.push('[.value[] | {' + jqKey(picked[0]) + ', ' + jqKey(picked[1]) + '}]');
      }
      if (picked.length >= 1) {
        out.push('.value | map(select(.' + jqKey(picked[0]) + ' != null))');
      }
      out.push('.value | length');
      if (typeof json['@odata.nextLink'] === 'string') {
        out.push('."@odata.nextLink"');
      }
      return out;
    }
    var topKeys = Object.keys(json).filter(function (key) {
      return key.indexOf('@') === -1;
    });
    for (var t = 0; t < topKeys.length && t < 3; t++) {
      out.push('.' + jqKey(topKeys[t]));
    }
    out.push('keys');
    return out;
  }

  /**
   * Suggest queries based on the shape of a Graph response, in the given
   * query language ('jmespath' by default, 'jsonpath', or 'jq').
   * Returns an array of query strings, most useful first.
   */
  function suggestQueries(json, language) {
    if (language === 'jsonpath') {
      return suggestJsonPathQueries(json);
    }
    if (language === 'jq') {
      return suggestJqQueries(json);
    }
    return suggestJmesPathQueries(json);
  }

  /** jq accessor for a key: `.key` or `."quoted key"`. */
  function jqKey(key) {
    if (PLAIN_IDENTIFIER.test(key)) {
      return key;
    }
    return '"' + String(key).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }

  // --------------------------------------------------- query completions

  function fn(name, detail) {
    return { label: name + '(', insert: name + '(', detail: detail };
  }

  function word(name, detail) {
    return { label: name, insert: name, detail: detail };
  }

  function snippet(match, insert, detail) {
    return { label: insert, match: match, insert: insert, detail: detail };
  }

  // Function lists mirror what the bundled engines actually implement
  // (jmespath.js functionTable / jqts builtins) — verified by tests.
  var QUERY_COMPLETIONS = {
    jmespath: [
      fn('abs', 'absolute value'),
      fn('avg', 'average of numbers'),
      fn('ceil', 'round up'),
      fn('contains', 'substring / element test'),
      fn('ends_with', 'string suffix test'),
      fn('floor', 'round down'),
      fn('join', 'join strings'),
      fn('keys', 'object keys'),
      fn('length', 'count items / chars'),
      fn('map', 'apply expression to array'),
      fn('max', 'largest value'),
      fn('max_by', 'largest by expression'),
      fn('merge', 'merge objects'),
      fn('min', 'smallest value'),
      fn('min_by', 'smallest by expression'),
      fn('not_null', 'first non-null argument'),
      fn('reverse', 'reverse array / string'),
      fn('sort', 'sort array'),
      fn('sort_by', 'sort by expression'),
      fn('starts_with', 'string prefix test'),
      fn('sum', 'sum of numbers'),
      fn('to_array', 'wrap in array'),
      fn('to_number', 'convert to number'),
      fn('to_string', 'convert to string'),
      fn('type', 'type name'),
      fn('values', 'object values')
    ],
    jq: [
      word('add', 'sum / concatenate items'),
      word('all', 'true when all items truthy'),
      word('any', 'true when any item truthy'),
      fn('contains', 'containment test'),
      word('empty', 'no output'),
      word('first', 'first output'),
      word('flatten', 'flatten nested arrays'),
      word('floor', 'round down'),
      fn('from_entries', 'build object from {key,value} list'),
      fn('group_by', 'group items by expression'),
      fn('has', 'key / index presence'),
      fn('endswith', 'string suffix test'),
      word('keys', 'object keys / array indexes'),
      word('last', 'last output'),
      word('length', 'count items / chars'),
      fn('map', 'apply filter to each item'),
      word('max', 'largest value'),
      fn('max_by', 'largest by expression'),
      word('min', 'smallest value'),
      fn('min_by', 'smallest by expression'),
      fn('range', 'number sequence'),
      word('reverse', 'reverse array'),
      fn('select', 'keep items matching condition'),
      word('sort', 'sort array'),
      fn('sort_by', 'sort by expression'),
      word('sqrt', 'square root'),
      fn('startswith', 'string prefix test'),
      fn('to_entries', 'object → {key,value} list'),
      word('tonumber', 'convert to number'),
      word('tostring', 'convert to string'),
      word('type', 'type name'),
      fn('unique_by', 'dedupe by expression'),
      word('unique', 'dedupe array'),
      word('values', 'object / array values'),
      fn('with_entries', 'transform object entries')
    ],
    jsonpath: [
      snippet('wildcard', '[*]', 'every item'),
      snippet('all', '[*]', 'every item'),
      snippet('recursive', '..', 'recursive descent'),
      snippet('filter', "[?(@.prop == 'value')]", 'filter items'),
      snippet('exists', '[?(@.prop)]', 'items where a field exists'),
      snippet('slice', '[0:5]', 'array slice'),
      snippet('length', '.length', 'count items'),
      snippet('property', "[?(@property === 'name')]", 'match by property name'),
      snippet('root', '$', 'document root')
    ]
  };

  /**
   * Tier-1 completion: match the identifier fragment before the cursor
   * against the language's function/keyword list. Returns
   * { replaceFrom, fragment, items } or null (no fragment, no matches,
   * or the cursor is inside a string literal).
   */
  function queryCompletions(language, textBeforeCursor) {
    var entries = QUERY_COMPLETIONS[language];
    if (!entries || typeof textBeforeCursor !== 'string') {
      return null;
    }
    var quote = null;
    for (var i = 0; i < textBeforeCursor.length; i++) {
      var ch = textBeforeCursor[i];
      if (quote) {
        if (ch === '\\') {
          i++;
        } else if (ch === quote) {
          quote = null;
        }
      } else if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
      }
    }
    if (quote !== null) {
      return null; // inside a string literal
    }
    var fragmentMatch = /[A-Za-z_][A-Za-z0-9_]*$/.exec(textBeforeCursor);
    if (!fragmentMatch) {
      return null;
    }
    var fragment = fragmentMatch[0];
    var lower = fragment.toLowerCase();
    var items = entries.filter(function (entry) {
      var key = (entry.match || entry.label).toLowerCase();
      return key.indexOf(lower) === 0 && key !== lower;
    });
    if (items.length === 0) {
      return null;
    }
    return {
      replaceFrom: textBeforeCursor.length - fragment.length,
      fragment: fragment,
      items: items
    };
  }

  // ----------------------------------------------------- query conversion

  /**
   * Best-effort conversion of simple path queries between JMESPath,
   * JSONPath, and jq. Queries are parsed into a shared model of path
   * segments (keys, wildcards, indexes, slices, one simple filter) plus
   * an optional trailing count; anything beyond that subset (pipes,
   * functions, reshaping, recursive descent, …) is not convertible and
   * conversion reports ok: false so the caller can leave the query
   * untouched.
   */

  var FILTER_OPS = ['==', '!=', '<=', '>=', '<', '>'];

  function readQuoted(text, start, quote) {
    // Returns { value, end } for a quoted string starting at `start`
    // (which must be the opening quote), or null.
    if (text[start] !== quote) {
      return null;
    }
    var value = '';
    for (var i = start + 1; i < text.length; i++) {
      var ch = text[i];
      if (ch === '\\' && i + 1 < text.length) {
        value += text[i + 1];
        i++;
      } else if (ch === quote) {
        return { value: value, end: i + 1 };
      } else {
        value += ch;
      }
    }
    return null;
  }

  function parseFilterLiteral(text) {
    // 'str', "str", `123`, or bare number → { kind, v } | null
    var trimmed = text.trim();
    if (trimmed === '') {
      return null;
    }
    var quoted = readQuoted(trimmed, 0, "'") || readQuoted(trimmed, 0, '"') || readQuoted(trimmed, 0, '`');
    if (quoted && quoted.end === trimmed.length) {
      if (trimmed[0] === '`') {
        var n = Number(quoted.value);
        return isFinite(n) ? { kind: 'number', v: n } : null;
      }
      return { kind: 'string', v: quoted.value };
    }
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      return { kind: 'number', v: Number(trimmed) };
    }
    return null;
  }

  function parseFilterBody(body) {
    // `<field>` or `<field> <op> <literal>`; field is an identifier or
    // quoted. Returns a filter segment or null.
    var trimmed = body.trim();
    var field = null;
    var rest = '';
    if (trimmed[0] === '"' || trimmed[0] === "'") {
      var quoted = readQuoted(trimmed, 0, trimmed[0]);
      if (!quoted) {
        return null;
      }
      field = quoted.value;
      rest = trimmed.slice(quoted.end);
    } else {
      var identMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(trimmed);
      if (!identMatch) {
        return null;
      }
      field = identMatch[0];
      rest = trimmed.slice(field.length);
    }
    rest = rest.trim();
    if (rest === '') {
      return { type: 'filter', field: field, op: null, value: null };
    }
    for (var i = 0; i < FILTER_OPS.length; i++) {
      if (rest.indexOf(FILTER_OPS[i]) === 0) {
        var literal = parseFilterLiteral(rest.slice(FILTER_OPS[i].length));
        if (!literal) {
          return null;
        }
        return { type: 'filter', field: field, op: FILTER_OPS[i], value: literal };
      }
    }
    return null;
  }

  function parseBracketInner(inner, language) {
    // Shared bracket contents: wildcard, index, slice, quoted key, filter.
    var trimmed = inner.trim();
    if (trimmed === '' || trimmed === '*') {
      return { type: 'wildcard' };
    }
    if (/^-?\d+$/.test(trimmed)) {
      return { type: 'index', value: parseInt(trimmed, 10) };
    }
    var slice = /^(-?\d*):(-?\d*)$/.exec(trimmed);
    if (slice) {
      return { type: 'slice', from: slice[1], to: slice[2] };
    }
    if (trimmed[0] === "'" || trimmed[0] === '"') {
      var quoted = readQuoted(trimmed, 0, trimmed[0]);
      if (quoted && quoted.end === trimmed.length) {
        return { type: 'key', name: quoted.value };
      }
      return null;
    }
    if (trimmed[0] === '?') {
      var body = trimmed.slice(1).trim();
      if (language === 'jsonpath') {
        var wrapped = /^\((.*)\)$/.exec(body);
        if (!wrapped) {
          return null;
        }
        body = wrapped[1].trim();
        // Field references look like @.field or @['field'].
        if (body.indexOf('@') !== 0) {
          return null;
        }
        body = body.slice(1);
        if (body[0] === '.') {
          body = body.slice(1);
        } else if (body[0] === '[') {
          var close = body.indexOf(']');
          if (close === -1) {
            return null;
          }
          var keyPart = body.slice(1, close).trim();
          var keyQuoted = readQuoted(keyPart, 0, keyPart[0]);
          if (!keyQuoted || keyQuoted.end !== keyPart.length) {
            return null;
          }
          body = '"' + keyQuoted.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"' + body.slice(close + 1);
        } else {
          return null;
        }
      }
      return parseFilterBody(body);
    }
    return null;
  }

  /** Read a bracket group starting at `[`; returns { inner, end } | null. */
  function readBracket(text, start) {
    if (text[start] !== '[') {
      return null;
    }
    var depth = 0;
    var quote = null;
    for (var i = start; i < text.length; i++) {
      var ch = text[i];
      if (quote) {
        if (ch === '\\') {
          i++;
        } else if (ch === quote) {
          quote = null;
        }
      } else if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
      } else if (ch === '[') {
        depth++;
      } else if (ch === ']') {
        depth--;
        if (depth === 0) {
          return { inner: text.slice(start + 1, i), end: i + 1 };
        }
      }
    }
    return null;
  }

  function parseJmesPathQuery(query) {
    var text = query.trim();
    var count = false;
    var lengthMatch = /^length\((.*)\)$/.exec(text);
    if (lengthMatch) {
      count = true;
      text = lengthMatch[1].trim();
    }
    var segments = [];
    var i = 0;
    while (i < text.length) {
      var ch = text[i];
      if (ch === '.') {
        if (segments.length === 0) {
          return null;
        }
        i++;
        ch = text[i];
        if (ch === undefined) {
          return null;
        }
      }
      if (ch === '"') {
        var quoted = readQuoted(text, i, '"');
        if (!quoted) {
          return null;
        }
        segments.push({ type: 'key', name: quoted.value });
        i = quoted.end;
      } else if (/[A-Za-z_]/.test(ch)) {
        var ident = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i))[0];
        segments.push({ type: 'key', name: ident });
        i += ident.length;
      } else if (ch === '[') {
        var bracket = readBracket(text, i);
        if (!bracket) {
          return null;
        }
        var segment = parseBracketInner(bracket.inner, 'jmespath');
        if (!segment || segment.type === 'key') {
          return null; // JMESPath uses ."quoted", not ['quoted']
        }
        segments.push(segment);
        i = bracket.end;
      } else {
        return null;
      }
    }
    if (segments.length === 0) {
      return null;
    }
    return { count: count, segments: segments };
  }

  function parseJsonPathQuery(query) {
    var text = query.trim();
    if (text[0] !== '$') {
      return null;
    }
    var segments = [];
    var i = 1;
    while (i < text.length) {
      var ch = text[i];
      if (ch === '.') {
        if (text[i + 1] === '.') {
          return null; // recursive descent has no equivalent
        }
        i++;
        var ident = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text.slice(i));
        if (!ident) {
          return null;
        }
        segments.push({ type: 'key', name: ident[0] });
        i += ident[0].length;
      } else if (ch === '[') {
        var bracket = readBracket(text, i);
        if (!bracket) {
          return null;
        }
        var segment = parseBracketInner(bracket.inner, 'jsonpath');
        if (!segment) {
          return null;
        }
        segments.push(segment);
        i = bracket.end;
      } else {
        return null;
      }
    }
    // Trailing `.length` is jsonpath-plus's way of counting. (A genuine
    // key named "length" in that position converts to a count instead —
    // acceptable for a best-effort converter.)
    var count = false;
    var last = segments[segments.length - 1];
    if (segments.length >= 2 && last && last.type === 'key' && last.name === 'length') {
      segments.pop();
      count = true;
    }
    if (segments.length === 0) {
      return null;
    }
    return { count: count, segments: segments };
  }

  function parseJqQuery(query) {
    var text = query.trim();
    var count = false;
    var pipeParts = text.split('|');
    if (pipeParts.length === 2 && pipeParts[1].trim() === 'length') {
      count = true;
      text = pipeParts[0].trim();
    } else if (pipeParts.length > 1) {
      return null;
    }
    if (text[0] !== '.') {
      return null;
    }
    var segments = [];
    var i = 0;
    while (i < text.length) {
      var ch = text[i];
      if (ch === '.') {
        i++;
        var next = text[i];
        if (next === '"') {
          var quoted = readQuoted(text, i, '"');
          if (!quoted) {
            return null;
          }
          segments.push({ type: 'key', name: quoted.value });
          i = quoted.end;
        } else if (next !== undefined && /[A-Za-z_]/.test(next)) {
          var ident = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i))[0];
          segments.push({ type: 'key', name: ident });
          i += ident.length;
        } else if (next === '[') {
          continue; // `.[…]` — bracket handled below
        } else {
          return null;
        }
      } else if (ch === '[') {
        var bracket = readBracket(text, i);
        if (!bracket) {
          return null;
        }
        var segment = parseBracketInner(bracket.inner, 'jq');
        if (!segment || segment.type === 'key' || segment.type === 'filter') {
          return null;
        }
        segments.push(segment);
        i = bracket.end;
      } else {
        return null;
      }
    }
    if (segments.length === 0) {
      return null;
    }
    return { count: count, segments: segments };
  }

  function emitFilterLiteral(literal, quote) {
    if (literal.kind === 'number') {
      return String(literal.v);
    }
    var escaped = String(literal.v).replace(/\\/g, '\\\\').replace(new RegExp(quote, 'g'), '\\' + quote);
    return quote + escaped + quote;
  }

  function emitJmesPathQuery(model) {
    var out = '';
    for (var i = 0; i < model.segments.length; i++) {
      var segment = model.segments[i];
      switch (segment.type) {
        case 'key':
          out += (out === '' ? '' : '.') + jmesKey(segment.name);
          break;
        case 'wildcard':
          out += '[]';
          break;
        case 'index':
          out += '[' + segment.value + ']';
          break;
        case 'slice':
          out += '[' + segment.from + ':' + segment.to + ']';
          break;
        case 'filter':
          out += '[?' + jmesKey(segment.field);
          if (segment.op) {
            out += ' ' + segment.op + ' ';
            out += segment.value.kind === 'number' ? '`' + segment.value.v + '`' : emitFilterLiteral(segment.value, "'");
          }
          out += ']';
          break;
        default:
          return null;
      }
    }
    if (out === '') {
      return null;
    }
    return model.count ? 'length(' + out + ')' : out;
  }

  function emitJsonPathQuery(model) {
    var out = '$';
    for (var i = 0; i < model.segments.length; i++) {
      var segment = model.segments[i];
      switch (segment.type) {
        case 'key':
          out += PLAIN_IDENTIFIER.test(segment.name)
            ? '.' + segment.name
            : "['" + segment.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "']";
          break;
        case 'wildcard':
          out += '[*]';
          break;
        case 'index':
          out += '[' + segment.value + ']';
          break;
        case 'slice':
          out += '[' + segment.from + ':' + segment.to + ']';
          break;
        case 'filter':
          var field = PLAIN_IDENTIFIER.test(segment.field)
            ? '.' + segment.field
            : "['" + segment.field.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "']";
          out += '[?(@' + field;
          if (segment.op) {
            out += ' ' + segment.op + ' ' + emitFilterLiteral(segment.value, "'");
          }
          out += ')]';
          break;
        default:
          return null;
      }
    }
    return model.count ? out + '.length' : out;
  }

  function emitJqQuery(model) {
    var out = '';
    for (var i = 0; i < model.segments.length; i++) {
      var segment = model.segments[i];
      switch (segment.type) {
        case 'key':
          out += '.' + jqKey(segment.name);
          break;
        case 'wildcard':
          out += (out === '' ? '.' : '') + '[]';
          break;
        case 'index':
          out += (out === '' ? '.' : '') + '[' + segment.value + ']';
          break;
        case 'slice':
          out += (out === '' ? '.' : '') + '[' + segment.from + ':' + segment.to + ']';
          break;
        case 'filter':
          // Only expressible cleanly as a trailing map(select(…)).
          if (i !== model.segments.length - 1) {
            return null;
          }
          var condition = '.' + jqKey(segment.field);
          condition += segment.op
            ? ' ' + segment.op + ' ' + emitFilterLiteral(segment.value, '"')
            : ' != null';
          out = (out === '' ? '.' : out) + ' | map(select(' + condition + '))';
          break;
        default:
          return null;
      }
    }
    if (out === '') {
      return null;
    }
    return model.count ? out + ' | length' : out;
  }

  var QUERY_PARSERS = {
    jmespath: parseJmesPathQuery,
    jsonpath: parseJsonPathQuery,
    jq: parseJqQuery
  };
  var QUERY_EMITTERS = {
    jmespath: emitJmesPathQuery,
    jsonpath: emitJsonPathQuery,
    jq: emitJqQuery
  };

  /**
   * Convert a query between languages when it falls into the shared
   * simple-path subset. Returns { ok: true, query } or { ok: false }.
   */
  function convertQuery(query, fromLanguage, toLanguage) {
    if (fromLanguage === toLanguage) {
      return { ok: true, query: query };
    }
    var parse = QUERY_PARSERS[fromLanguage];
    var emit = QUERY_EMITTERS[toLanguage];
    if (!parse || !emit) {
      return { ok: false };
    }
    var model;
    try {
      model = parse(query);
    } catch (e) {
      model = null;
    }
    if (!model) {
      return { ok: false };
    }
    var emitted = emit(model);
    if (emitted === null) {
      return { ok: false };
    }
    return { ok: true, query: emitted };
  }

  // Graph Explorer's own AAD client id — its permission-management
  // requests (oauth2PermissionGrants, servicePrincipals) embed it.
  var GRAPH_EXPLORER_CLIENT_ID = 'de8bc8b5-d9f9-48b1-a8ad-b748da725064';

  // Exact request URLs (path only, no query string) Graph Explorer
  // issues on its own after sign-in: signed-in user, profile type,
  // tenant organization.
  var BACKGROUND_PATHS = ['/v1.0/me', '/beta/me/profile', '/beta/me/photo/$value', '/v1.0/organization'];

  /**
   * True when a captured request looks like one of Graph Explorer's own
   * background calls (sign-in profile/organization lookups, permission
   * management) rather than a query the user ran. Note the ambiguity: a
   * deliberately-run plain `GET /me` matches too — the panel keeps such
   * entries behind a "background" toggle instead of dropping them.
   */
  function isBackgroundGraphRequest(url) {
    var parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return false;
    }
    var path = parsed.pathname.replace(/\/+$/, '').toLowerCase();
    if (parsed.search === '' && BACKGROUND_PATHS.indexOf(path) !== -1) {
      return true;
    }
    var query;
    try {
      query = decodeURIComponent(parsed.search).toLowerCase();
    } catch (e) {
      query = parsed.search.toLowerCase();
    }
    if (query.indexOf(GRAPH_EXPLORER_CLIENT_ID) !== -1) {
      return true; // permission grants / service principal lookups for GE itself
    }
    if (/\/oauth2permissiongrants(\/|$)/.test(path) || /\/serviceprincipals(\/|$)/.test(path)) {
      return true;
    }
    return false;
  }

  /**
   * True when a captured request URL corresponds to the query currently
   * sitting in Graph Explorer's URI field — the strongest signal that
   * the user ran it deliberately. Tolerates encoding differences and the
   * extra `$count=true` the advanced-query setting injects.
   */
  function graphRequestMatchesEditor(capturedUrl, editorValue) {
    if (!editorValue || typeof editorValue !== 'string') {
      return false;
    }
    var captured;
    try {
      captured = new URL(capturedUrl);
    } catch (e) {
      return false;
    }
    var editor = null;
    var trimmed = editorValue.trim();
    try {
      editor = new URL(trimmed);
    } catch (e) {
      try {
        editor = new URL(trimmed, captured.origin);
      } catch (e2) {
        return false;
      }
    }
    if (captured.origin.toLowerCase() !== editor.origin.toLowerCase()) {
      return false;
    }
    var capturedPath = captured.pathname.replace(/\/+$/, '').toLowerCase();
    var editorPath = editor.pathname.replace(/\/+$/, '').toLowerCase();
    if (capturedPath !== editorPath) {
      return false;
    }
    var capturedParams = {};
    captured.searchParams.forEach(function (value, key) {
      capturedParams[key.toLowerCase()] = value;
    });
    var mismatch = false;
    var seen = {};
    editor.searchParams.forEach(function (value, key) {
      var k = key.toLowerCase();
      if (!(k in capturedParams) || capturedParams[k] !== value) {
        mismatch = true;
      }
      seen[k] = true;
    });
    if (mismatch) {
      return false;
    }
    var extras = Object.keys(capturedParams).filter(function (k) {
      return !seen[k] && !(k === '$count' && capturedParams[k] === 'true');
    });
    return extras.length === 0;
  }

  /**
   * Decide whether a captured Graph request is one of Graph Explorer's
   * own background calls, combining three signals:
   *  - known-internal URL patterns (profile, organization, permission
   *    grants, service principals),
   *  - whether the URL matches the query in Graph Explorer's URI field,
   *  - whether the user recently ran a query (Run button / Enter),
   *    passed as msSinceRun (-1 = never).
   * The URI field alone is not enough: it is pre-filled with /v1.0/me,
   * which is exactly what Graph Explorer fetches on sign-in — hence
   * pattern matches also require a recent run to count as user-driven.
   * Unknown URLs that match neither the field nor a recent run are
   * treated as background too (Graph Explorer may add new internal
   * calls); the panel keeps them behind a toggle rather than dropping
   * them, so a misclassification is always recoverable.
   */
  function classifyBackgroundRequest(url, editorValue, msSinceRun) {
    var recentRun = typeof msSinceRun === 'number' && msSinceRun >= 0 && msSinceRun < 15000;
    var editorMatch = graphRequestMatchesEditor(url, editorValue);
    if (isBackgroundGraphRequest(url)) {
      return !(editorMatch && recentRun);
    }
    if (editorMatch) {
      return false;
    }
    return !recentRun;
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
   * Trim the query history to `limit` entries (0/null = unlimited),
   * removing the oldest unstarred entries first. Starred (favorite)
   * entries are never removed automatically.
   */
  function trimQueryHistoryList(list, limit) {
    if (!limit || limit <= 0 || !Array.isArray(list) || list.length <= limit) {
      return list;
    }
    var out = list.slice();
    for (var i = out.length - 1; i >= 0 && out.length > limit; i--) {
      if (!out[i].starred) {
        out.splice(i, 1);
      }
    }
    return out;
  }

  /**
   * Insert an executed query into the query history (newest first).
   * Entries are unique per (language, query): re-running a query moves it
   * to the top, bumps `uses`, refreshes `lastUsed`/`context`, and keeps
   * its star and tags. `limit` caps the list length (favorites exempt);
   * 0 (or null) means unlimited.
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
      context: entry.context || (existing && existing.context) || null,
      starred: !!(existing && existing.starred),
      tags: (existing && existing.tags) || []
    });
    return trimQueryHistoryList(out, limit);
  }

  /**
   * Group the query history for display: favorites first, then one group
   * per tag (alphabetical; an unstarred entry goes under its first tag),
   * then the untagged rest under "Recent". Order inside each group stays
   * newest-first. Returns [{ title, items }] with empty groups omitted.
   */
  function groupQueryHistory(list) {
    var favorites = [];
    var tagGroups = {};
    var recent = [];
    (Array.isArray(list) ? list : []).forEach(function (item) {
      if (!item) {
        return;
      }
      if (item.starred) {
        favorites.push(item);
        return;
      }
      var tag = Array.isArray(item.tags) && item.tags.length > 0 ? String(item.tags[0]) : null;
      if (tag) {
        (tagGroups[tag] = tagGroups[tag] || []).push(item);
      } else {
        recent.push(item);
      }
    });
    var groups = [];
    if (favorites.length > 0) {
      groups.push({ title: '★ Favorites', items: favorites });
    }
    Object.keys(tagGroups)
      .sort(function (a, b) {
        return a.localeCompare(b);
      })
      .forEach(function (tag) {
        groups.push({ title: tag, items: tagGroups[tag] });
      });
    if (recent.length > 0) {
      groups.push({ title: 'Recent', items: recent });
    }
    return groups;
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
    jqKey: jqKey,
    clampInt: clampInt,
    convertQuery: convertQuery,
    queryCompletions: queryCompletions,
    isBackgroundGraphRequest: isBackgroundGraphRequest,
    graphRequestMatchesEditor: graphRequestMatchesEditor,
    classifyBackgroundRequest: classifyBackgroundRequest,
    applyAdvancedQuery: applyAdvancedQuery,
    parseGraphRequest: parseGraphRequest,
    buildDeepLink: buildDeepLink,
    upsertQueryHistory: upsertQueryHistory,
    trimQueryHistoryList: trimQueryHistoryList,
    groupQueryHistory: groupQueryHistory,
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
