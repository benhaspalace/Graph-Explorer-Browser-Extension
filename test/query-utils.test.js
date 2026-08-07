'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const GEJQ = require('../src/query-utils.js');
const jmespath = require('../vendor/jmespath.js');

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
