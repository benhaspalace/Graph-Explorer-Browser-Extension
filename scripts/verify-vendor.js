#!/usr/bin/env node
'use strict';

/**
 * Verify the vendored third-party bundles against vendor/CHECKSUMS.txt.
 *
 * Supply-chain control: the query engines and the editor are committed to
 * the repository as pre-built bundles (no build step at install time). This
 * script recomputes their SHA-256 hashes and fails if any file has changed,
 * is missing, or is not listed — so tampering with a vendored bundle (in the
 * repo, a fork, or a release zip) breaks the build instead of shipping.
 *
 * Zero dependencies (Node's crypto only), so it runs anywhere Node does and
 * is itself not a supply-chain risk. Run with: npm run verify:vendor
 *
 * To intentionally update a bundle: rebuild it from the pinned upstream
 * version (see vendor headers / SBOM.md), then regenerate the checksums:
 *   sha256sum vendor/*.js > vendor/CHECKSUMS.txt   # or: npm run vendor:hash
 * and review the diff before committing.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const repoRoot = path.resolve(__dirname, '..');
const checksumFile = path.join(repoRoot, 'vendor', 'CHECKSUMS.txt');

function fail(message) {
  console.error('verify-vendor: ' + message);
  process.exit(1);
}

if (!fs.existsSync(checksumFile)) {
  fail('vendor/CHECKSUMS.txt not found');
}

// Parse "<hex sha256>  <path>" lines (the sha256sum format; two spaces).
const entries = fs
  .readFileSync(checksumFile, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'))
  .map((line) => {
    const match = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line);
    if (!match) {
      fail('malformed line in CHECKSUMS.txt: ' + JSON.stringify(line));
    }
    return { expected: match[1].toLowerCase(), file: match[2] };
  });

if (entries.length === 0) {
  fail('CHECKSUMS.txt lists no files');
}

// Every *.js under vendor/ must be covered — a new, unlisted bundle is
// exactly what an attacker would add, so treat it as a failure.
const listed = new Set(entries.map((e) => path.normalize(e.file)));
const present = fs
  .readdirSync(path.join(repoRoot, 'vendor'))
  .filter((name) => name.endsWith('.js'))
  .map((name) => path.join('vendor', name));
const unlisted = present.filter((file) => !listed.has(path.normalize(file)));
if (unlisted.length > 0) {
  fail('vendored file(s) not covered by CHECKSUMS.txt: ' + unlisted.join(', '));
}

let ok = 0;
for (const entry of entries) {
  const absolute = path.join(repoRoot, entry.file);
  if (!fs.existsSync(absolute)) {
    fail('listed file is missing: ' + entry.file);
  }
  const actual = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
  if (actual !== entry.expected) {
    fail('checksum mismatch for ' + entry.file + '\n  expected ' + entry.expected + '\n  actual   ' + actual);
  }
  ok++;
}

console.log('verify-vendor: OK — ' + ok + ' vendored file(s) match their pinned checksums.');
