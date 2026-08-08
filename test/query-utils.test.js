'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const GEJQ = require('../src/query-utils.js');
const jmespath = require('../vendor/jmespath.js');
const { JSONPath } = require('../vendor/jsonpath-plus.js');

const SAMPLE_USERS_RESPONSE = {
  '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#users',
  '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?$skiptoken=abc',
  value: [
    { id: '1', displayName: 'Adele Vance', mail: 'adele@contoso.com', jobTitle: 'Retail Manager' },
    { id: '2', displayName: 'Alex Wilber', mail: 'alex@contoso.com', jobTitle: 'Marketing Assistant' },
    { id: '3', displayName: 'Megan Bowen', mail: null, jobTitle: 'Auditor' }
  ]
};

test('jmesKey quotes only when needed', () => {
  assert.equal(GEJQ.jmesKey('displayName'), 'displayName');
  assert.equal(GEJQ.jmesKey('_private'), '_private');
  assert.equal(GEJQ.jmesKey('@odata.context'), '"@odata.context"');
  assert.equal(GEJQ.jmesKey('has space'), '"has space"');
  assert.equal(GEJQ.jmesKey('has"quote'), '"has\\"quote"');
});

test('safeJsonParse handles valid and invalid input', () => {
  assert.deepEqual(GEJQ.safeJsonParse('{"a":1}'), { ok: true, value: { a: 1 } });
  const bad = GEJQ.safeJsonParse('{nope');
  assert.equal(bad.ok, false);
  assert.ok(bad.error.length > 0);
});

test('describeResult covers common shapes', () => {
  assert.equal(GEJQ.describeResult([1, 2, 3]), 'array · 3 items');
  assert.equal(GEJQ.describeResult([1]), 'array · 1 item');
  assert.equal(GEJQ.describeResult({ a: 1, b: 2 }), 'object · 2 keys');
  assert.equal(GEJQ.describeResult('hi'), 'string · 2 chars');
  assert.equal(GEJQ.describeResult(42), 'number');
  assert.equal(GEJQ.describeResult(true), 'boolean');
  assert.equal(GEJQ.describeResult(null), 'null');
  assert.equal(GEJQ.describeResult(undefined), 'no result');
});

test('formatBytes renders human-readable sizes', () => {
  assert.equal(GEJQ.formatBytes(0), '0 B');
  assert.equal(GEJQ.formatBytes(512), '512 B');
  assert.equal(GEJQ.formatBytes(2048), '2 KB');
  assert.equal(GEJQ.formatBytes(5 * 1024 * 1024), '5 MB');
  assert.equal(GEJQ.formatBytes(-1), '');
  assert.equal(GEJQ.formatBytes(NaN), '');
});

test('summarizeUrl strips origin and truncates', () => {
  assert.equal(
    GEJQ.summarizeUrl('https://graph.microsoft.com/v1.0/me/messages?$top=5'),
    '/v1.0/me/messages?$top=5'
  );
  const long = 'https://graph.microsoft.com/v1.0/' + 'x'.repeat(200);
  assert.ok(GEJQ.summarizeUrl(long, 50).length <= 50);
  assert.ok(GEJQ.summarizeUrl(long, 50).endsWith('…'));
  assert.equal(GEJQ.summarizeUrl('not a url'), 'not a url');
});

test('trimHistory keeps the newest entries', () => {
  const entries = [5, 4, 3, 2, 1];
  assert.deepEqual(GEJQ.trimHistory(entries, 3), [5, 4, 3]);
  assert.deepEqual(GEJQ.trimHistory(entries, 10), entries);
  assert.deepEqual(GEJQ.trimHistory(null, 3), []);
});

test('suggestQueries proposes useful queries for collection responses', () => {
  const suggestions = GEJQ.suggestQueries(SAMPLE_USERS_RESPONSE);
  assert.ok(suggestions.includes('value[].displayName'));
  assert.ok(suggestions.includes('length(value)'));
  assert.ok(suggestions.includes('"@odata.nextLink"'));
});

test('every suggested query is valid JMESPath against the source data', () => {
  const shapes = [
    SAMPLE_USERS_RESPONSE,
    { id: '1', displayName: 'Adele Vance', '@odata.context': 'ctx' },
    [1, 2, 3],
    { value: [] },
    { value: [{ '@odata.type': '#microsoft.graph.user', 'odd key': 1 }] },
    'scalar',
    null
  ];
  for (const shape of shapes) {
    for (const query of GEJQ.suggestQueries(shape)) {
      assert.doesNotThrow(() => jmespath.search(shape, query), `query ${query} should compile`);
    }
  }
});

test('applyAdvancedQuery upgrades GET requests using advanced query options', () => {
  for (const trigger of ['$filter=startswith(displayName,%27a%27)', '$search="displayName:room"', '$orderby=displayName']) {
    const result = GEJQ.applyAdvancedQuery('https://graph.microsoft.com/v1.0/users?' + trigger, 'GET');
    assert.equal(result.addHeader, true, trigger);
    assert.ok(result.url.includes('%24count=true') || result.url.includes('$count=true'), result.url);
  }
});

test('applyAdvancedQuery keeps an existing $count and still asks for the header', () => {
  const url = 'https://graph.microsoft.com/v1.0/users?$count=true&$filter=x';
  const result = GEJQ.applyAdvancedQuery(url, 'GET');
  assert.equal(result.addHeader, true);
  assert.equal((result.url.match(/%24count|\$count/g) || []).length, 1);
});

test('applyAdvancedQuery handles /$count path segments', () => {
  const result = GEJQ.applyAdvancedQuery('https://graph.microsoft.com/v1.0/users/$count', 'GET');
  assert.equal(result.addHeader, true);
  assert.equal(result.url, 'https://graph.microsoft.com/v1.0/users/$count');
});

test('applyAdvancedQuery leaves plain and non-GET requests untouched', () => {
  const plain = GEJQ.applyAdvancedQuery('https://graph.microsoft.com/v1.0/me', 'GET');
  assert.deepEqual(plain, { url: 'https://graph.microsoft.com/v1.0/me', addHeader: false });

  const select = GEJQ.applyAdvancedQuery('https://graph.microsoft.com/v1.0/users?$select=id', 'GET');
  assert.equal(select.addHeader, false);
  assert.ok(!select.url.includes('$count'));

  const post = GEJQ.applyAdvancedQuery('https://graph.microsoft.com/v1.0/users?$filter=x', 'POST');
  assert.equal(post.addHeader, false);
  assert.ok(!post.url.includes('$count'));

  const invalid = GEJQ.applyAdvancedQuery('not a url', 'GET');
  assert.deepEqual(invalid, { url: 'not a url', addHeader: false });
});

test('applyAdvancedQuery preserves existing query parameters', () => {
  const result = GEJQ.applyAdvancedQuery(
    'https://graph.microsoft.com/v1.0/users?$select=displayName&$filter=startswith(displayName,%27a%27)&$top=5',
    'get'
  );
  assert.equal(result.addHeader, true);
  const parsed = new URL(result.url);
  assert.equal(parsed.searchParams.get('$select'), 'displayName');
  assert.equal(parsed.searchParams.get('$top'), '5');
  assert.equal(parsed.searchParams.get('$count'), 'true');
  assert.equal(parsed.searchParams.get('$filter'), "startswith(displayName,'a')");
});

test('suggestQueries also proposes JSONPath queries', () => {
  const suggestions = GEJQ.suggestQueries(SAMPLE_USERS_RESPONSE, 'jsonpath');
  assert.ok(suggestions.includes('$.value[*].displayName'));
  assert.ok(suggestions.includes('$.value.length'));
});

test('every suggested JSONPath query is valid against the source data', () => {
  const shapes = [
    SAMPLE_USERS_RESPONSE,
    { id: '1', displayName: 'Adele Vance', '@odata.context': 'ctx' },
    [1, 2, 3],
    { value: [] },
    { value: [{ '@odata.type': '#microsoft.graph.user', 'odd key': 1 }] },
    'scalar',
    null
  ];
  for (const shape of shapes) {
    for (const query of GEJQ.suggestQueries(shape, 'jsonpath')) {
      assert.doesNotThrow(
        () => JSONPath({ path: query, json: shape, wrap: true }),
        `query ${query} should evaluate`
      );
    }
  }
});

test('parseGraphRequest splits Graph URLs into deep-link parts', () => {
  assert.deepEqual(GEJQ.parseGraphRequest('https://graph.microsoft.com/v1.0/me/messages?$top=5'), {
    graphUrl: 'https://graph.microsoft.com',
    version: 'v1.0',
    request: 'me/messages?$top=5'
  });
  assert.deepEqual(GEJQ.parseGraphRequest('https://graph.microsoft.us/beta/users'), {
    graphUrl: 'https://graph.microsoft.us',
    version: 'beta',
    request: 'users'
  });
  assert.equal(GEJQ.parseGraphRequest('https://graph.microsoft.com/v2.0/users'), null);
  assert.equal(GEJQ.parseGraphRequest('https://graph.microsoft.com/v1.0'), null);
  assert.equal(GEJQ.parseGraphRequest('not a url'), null);
});

test('buildDeepLink produces Graph Explorer share-style links', () => {
  const link = GEJQ.buildDeepLink(
    'https://developer.microsoft.com/en-us/graph/graph-explorer',
    'get',
    'https://graph.microsoft.com/v1.0/me/messages?$top=5'
  );
  assert.equal(
    link,
    'https://developer.microsoft.com/en-us/graph/graph-explorer' +
      '?request=me%2Fmessages%3F%24top%3D5&method=GET&version=v1.0&GraphUrl=https%3A%2F%2Fgraph.microsoft.com'
  );
  assert.equal(GEJQ.buildDeepLink('https://x', 'GET', 'https://graph.microsoft.com/v2.0/oops'), null);
});

test('upsertQueryHistory keeps distinct queries newest-first with timestamps', () => {
  let history = [];
  history = GEJQ.upsertQueryHistory(history, { query: 'a', language: 'jmespath', lastUsed: 1000, context: { method: 'GET', url: '/v1.0/users' } }, 50);
  history = GEJQ.upsertQueryHistory(history, { query: 'b', language: 'jmespath', lastUsed: 2000, context: null }, 50);
  assert.deepEqual(history.map((h) => h.query), ['b', 'a']);
  assert.equal(history[1].lastUsed, 1000);
  assert.equal(history[1].context.url, '/v1.0/users');

  // Re-running "a" moves it up, bumps uses, refreshes lastUsed, keeps context.
  history = GEJQ.upsertQueryHistory(history, { query: 'a', language: 'jmespath', lastUsed: 3000, context: null }, 50);
  assert.deepEqual(history.map((h) => h.query), ['a', 'b']);
  assert.equal(history[0].uses, 2);
  assert.equal(history[0].lastUsed, 3000);
  assert.equal(history[0].context.url, '/v1.0/users');

  // Same text in a different language is a distinct entry.
  history = GEJQ.upsertQueryHistory(history, { query: 'a', language: 'jsonpath', lastUsed: 4000, context: null }, 50);
  assert.equal(history.length, 3);
});

test('upsertQueryHistory honors the limit; 0 means unlimited', () => {
  let history = [];
  for (let i = 0; i < 10; i++) {
    history = GEJQ.upsertQueryHistory(history, { query: 'q' + i, language: 'jmespath', lastUsed: i, context: null }, 3);
  }
  assert.equal(history.length, 3);
  assert.deepEqual(history.map((h) => h.query), ['q9', 'q8', 'q7']);

  let unlimited = [];
  for (let i = 0; i < 10; i++) {
    unlimited = GEJQ.upsertQueryHistory(unlimited, { query: 'q' + i, language: 'jmespath', lastUsed: i, context: null }, 0);
  }
  assert.equal(unlimited.length, 10);
});

test('formatTimestamp shows clock time today and full date otherwise', () => {
  const noon = new Date(2026, 7, 7, 12, 0, 0).getTime();
  const morning = new Date(2026, 7, 7, 9, 5, 7).getTime();
  const lastWeek = new Date(2026, 6, 30, 9, 5, 0).getTime();
  assert.equal(GEJQ.formatTimestamp(morning, noon), '09:05:07');
  assert.equal(GEJQ.formatTimestamp(lastWeek, noon), '2026-07-30 09:05');
});

test('clampInt clamps numbers and numeric strings, falls back otherwise', () => {
  assert.equal(GEJQ.clampInt(5, 1, 10, 3), 5);
  assert.equal(GEJQ.clampInt(99, 1, 10, 3), 10);
  assert.equal(GEJQ.clampInt(0, 1, 10, 3), 3);
  assert.equal(GEJQ.clampInt(7.9, 1, 10, 3), 7);
  assert.equal(GEJQ.clampInt('42', 1, 100, 3), 42);
  assert.equal(GEJQ.clampInt('nope', 1, 10, 3), 3);
  assert.equal(GEJQ.clampInt(undefined, 1, 10, 3), 3);
  assert.equal(GEJQ.clampInt(NaN, 1, 10, 3), 3);
});

test('csvEligible agrees with toCsv across shapes', () => {
  const shapes = [
    [{ a: 1 }, { b: 2 }],
    [{}],
    [{}, { a: 1 }],
    ['a', 'b'],
    [1, null, true],
    [],
    [{ a: 1 }, 'mixed'],
    [[1, 2]],
    { a: 1 },
    'scalar',
    null,
    42
  ];
  for (const shape of shapes) {
    assert.equal(
      GEJQ.csvEligible(shape),
      GEJQ.toCsv(shape) !== null,
      'csvEligible must match toCsv for ' + JSON.stringify(shape)
    );
  }
});

test('exportFilename derives a name from the request path plus timestamp', () => {
  const now = new Date(2026, 7, 8, 9, 30, 5).getTime();
  assert.equal(
    GEJQ.exportFilename('https://graph.microsoft.com/v1.0/me/messages?$top=5', 'json', now),
    'graph-me-messages-2026-08-08-093005.json'
  );
  assert.equal(
    GEJQ.exportFilename('https://graph.microsoft.com/beta/users', 'csv', now),
    'graph-users-2026-08-08-093005.csv'
  );
  assert.equal(GEJQ.exportFilename('pasted JSON #1', 'json', now), 'graph-query-2026-08-08-093005.json');
  assert.equal(GEJQ.exportFilename('', 'json', now), 'graph-query-2026-08-08-093005.json');
});

test('toCsv converts arrays of objects with union of columns', () => {
  const csv = GEJQ.toCsv([
    { name: 'Adele', mail: 'a@x.com' },
    { name: 'Alex', dept: 'Sales' }
  ]);
  assert.equal(csv, 'name,mail,dept\r\nAdele,a@x.com,\r\nAlex,,Sales');
});

test('toCsv escapes quotes, commas and newlines', () => {
  const csv = GEJQ.toCsv([{ note: 'has "quote", and comma', plain: 'x\ny' }]);
  assert.equal(csv, 'note,plain\r\n"has ""quote"", and comma","x\ny"');
});

test('toCsv handles arrays of scalars and rejects mixed/unsupported shapes', () => {
  assert.equal(GEJQ.toCsv(['a', 'b']), 'value\r\na\r\nb');
  assert.equal(GEJQ.toCsv([1, null, true]), 'value\r\n1\r\n\r\ntrue');
  assert.equal(GEJQ.toCsv([]), null);
  assert.equal(GEJQ.toCsv({ a: 1 }), null);
  assert.equal(GEJQ.toCsv('nope'), null);
  assert.equal(GEJQ.toCsv([{ a: 1 }, 'mixed']), null);
});

test('toCsv JSON-encodes nested values into cells', () => {
  const csv = GEJQ.toCsv([{ name: 'A', tags: ['x', 'y'] }]);
  assert.equal(csv, 'name,tags\r\nA,"[""x"",""y""]"');
});

test('vendored jmespath supports the documented example queries', () => {
  assert.deepEqual(
    jmespath.search(SAMPLE_USERS_RESPONSE, 'value[].displayName'),
    ['Adele Vance', 'Alex Wilber', 'Megan Bowen']
  );
  assert.deepEqual(
    jmespath.search(SAMPLE_USERS_RESPONSE, "value[?contains(displayName, 'Vance')].mail"),
    ['adele@contoso.com']
  );
  assert.deepEqual(
    jmespath.search(SAMPLE_USERS_RESPONSE, 'value[].{name: displayName, email: mail}')[0],
    { name: 'Adele Vance', email: 'adele@contoso.com' }
  );
  assert.equal(jmespath.search(SAMPLE_USERS_RESPONSE, 'length(value)'), 3);
  assert.deepEqual(
    jmespath.search(SAMPLE_USERS_RESPONSE, 'sort_by(value, &displayName)[0].displayName'),
    'Adele Vance'
  );
  assert.equal(
    jmespath.search(SAMPLE_USERS_RESPONSE, '"@odata.nextLink"'),
    'https://graph.microsoft.com/v1.0/users?$skiptoken=abc'
  );
});
