/**
 * End-to-end smoke test: loads the extension into Chromium (headless)
 * and drives it against a Graph Explorer stand-in page served entirely
 * through Playwright route interception — no network access needed.
 *
 * Requirements: Playwright with its Chromium build available
 * (`npm i -D playwright && npx playwright install chromium`, or a
 * global install reachable via NODE_PATH).
 *
 * Run with: npm run e2e
 */
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');

const EXT = path.resolve(__dirname, '..', '..');
const SHOT_DIR = path.join(__dirname, 'artifacts');

// Minimal stand-in for the Graph Explorer page: same URL, same
// #response-area anchor the embed logic targets.
const FIXTURE_HTML = `<!DOCTYPE html>
<html><head><title>Graph Explorer fixture</title><style>
  body { margin:0; font-family:sans-serif; }
  #app { display:flex; flex-direction:column; height:100vh; }
  #request { height:120px; background:#eee; padding:12px; }
  #response-area { flex:1; overflow:auto; padding:8px; }
  #ge-response { background:#fafafa; border:1px solid #ccc; height:100%; overflow:auto; }
</style></head>
<body>
<div id="app">
  <div id="request">Graph Explorer fixture —
    <button aria-label="HTTP request method option" id="ge-method">GET</button>
    <input aria-label="Query sample input" id="ge-editor-input" size="60" />
    <button aria-label="Run query" id="ge-run">▶ Run query</button>
    <button aria-label="Sign in" id="fake-profile-view">(avatar)</button>
    <span>
      <button role="tab" aria-selected="true" id="fake-body-tab">Request body</button>
      <button role="tab" aria-selected="false" id="request-headers">Request headers</button>
    </span>
    <div role="tabpanel" id="ge-headers-panel" hidden>
      <input name="name" placeholder="Key" /> <input name="value" placeholder="Value" />
      <button id="ge-add-header">Add</button>
      <ul id="ge-header-list"></ul>
    </div>
  </div>
  <div id="response-area"><div id="ge-response"><pre id="ge-json">(run a query)</pre></div></div>
</div>
<script>
  window.__signInClicks = 0;
  document.getElementById('fake-profile-view').addEventListener('click', function () {
    window.__signInClicks++;
  });
  // Mimic Graph Explorer running a query: the URI field always holds the
  // query being run (that's how the extension tells user queries apart
  // from Graph Explorer's own background calls).
  window.runGraphQuery = function (path) {
    var url = 'https://graph.microsoft.com' + (path || '/v1.0/users?$top=3');
    document.getElementById('ge-editor-input').value = url;
    return fetch(url, {
      headers: { Accept: 'application/json' }
    }).then(r => r.json()).then(j => {
      document.getElementById('ge-json').textContent = JSON.stringify(j, null, 2);
      return j;
    });
  };
  document.getElementById('ge-run').addEventListener('click', function () {
    var url = document.getElementById('ge-editor-input').value;
    window.runGraphQuery(url.replace('https://graph.microsoft.com', ''));
  });
  // Minimal stand-in for GE's Request-headers tab.
  function selectTab(which) {
    document.getElementById('fake-body-tab').setAttribute('aria-selected', String(which === 'body'));
    document.getElementById('request-headers').setAttribute('aria-selected', String(which === 'headers'));
    document.getElementById('ge-headers-panel').hidden = which !== 'headers';
  }
  document.getElementById('fake-body-tab').addEventListener('click', function () { selectTab('body'); });
  document.getElementById('request-headers').addEventListener('click', function () { selectTab('headers'); });
  // Like real GE, the Add button stays disabled until both inputs have
  // values (React-processed) — the extension must wait for that.
  var headerName = document.querySelector('input[name="name"]');
  var headerValue = document.querySelector('input[name="value"]');
  var addHeaderBtn = document.getElementById('ge-add-header');
  function syncAddButton() {
    addHeaderBtn.disabled = !(headerName.value && headerValue.value);
  }
  syncAddButton();
  headerName.addEventListener('input', function () { setTimeout(syncAddButton, 30); });
  headerValue.addEventListener('input', function () { setTimeout(syncAddButton, 30); });
  addHeaderBtn.addEventListener('click', function () {
    if (!headerName.value) return;
    var li = document.createElement('li');
    li.textContent = headerName.value + ': ' + headerValue.value;
    document.getElementById('ge-header-list').appendChild(li);
    headerName.value = '';
    headerValue.value = '';
    syncAddButton();
  });
</script>
</body></html>`;

const SAMPLE_RESPONSE = {
  '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#users',
  value: [
    { id: '1', displayName: 'Adele Vance', mail: 'adele@contoso.com', jobTitle: 'Retail Manager' },
    { id: '2', displayName: 'Alex Wilber', mail: 'alex@contoso.com', jobTitle: 'Marketing Assistant' },
    { id: '3', displayName: 'Megan Bowen', mail: 'megan@contoso.com', jobTitle: 'Auditor' }
  ]
};

let failures = 0;
function check(name, ok, extra) {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (extra ? ' — ' + extra : ''));
  if (!ok) failures++;
}

(async () => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gejq-e2e-profile-'));
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    channel: 'chromium',
    viewport: { width: 1440, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
  });
  // Tabs opened by the extension itself (chrome.tabs.create) need a
  // context-level route so their navigation can commit offline.
  await ctx.route('https://developer.microsoft.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>GE</title>Graph Explorer stub' })
  );

  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));

  const PAGE_TWO = {
    '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?paged=3',
    value: [
      { id: '4', displayName: 'Nestor Wilke', mail: 'nestor@contoso.com', jobTitle: 'Director' },
      { id: '5', displayName: 'Lidia Holloway', mail: 'lidia@contoso.com', jobTitle: 'Engineer' },
      { id: '6', displayName: 'Lynne Robbins', mail: 'lynne@contoso.com', jobTitle: 'Planner' }
    ]
  };
  const PAGE_THREE = {
    value: [
      { id: '7', displayName: 'Joni Sherman', mail: 'joni@contoso.com', jobTitle: 'Paralegal' },
      { id: '8', displayName: 'Isaiah Langer', mail: 'isaiah@contoso.com', jobTitle: 'Sales Rep' },
      { id: '9', displayName: 'Patti Fernandez', mail: 'patti@contoso.com', jobTitle: 'President' }
    ]
  };

  const graphRequests = [];
  let extOrigin = null;
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('https://developer.microsoft.com/en-us/graph/graph-explorer')) {
      return route.fulfill({ contentType: 'text/html', body: FIXTURE_HTML });
    }
    if (url.startsWith('https://graph.microsoft.com/')) {
      graphRequests.push({ url, headers: route.request().headers() });
      let body = SAMPLE_RESPONSE;
      if (url.includes('paged=1')) {
        body = Object.assign({}, SAMPLE_RESPONSE, {
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?paged=2'
        });
      } else if (url.includes('paged=2')) {
        body = PAGE_TWO;
      } else if (url.includes('paged=3')) {
        body = PAGE_THREE;
      }
      return route.fulfill({
        contentType: 'application/json;odata.metadata=minimal',
        body: JSON.stringify(body)
      });
    }
    if (url.startsWith('chrome-extension://')) {
      return route.fallback(); // extension resources load normally
    }
    return route.abort();
  });

  // Unpacked extension IDs derive from the SHA-256 of the install path;
  // the background service worker URL confirms it once registered.
  {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(EXT, 'utf8').digest('hex').slice(0, 32);
    const computedId = hash
      .split('')
      .map((c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16)))
      .join('');
    extOrigin = 'chrome-extension://' + computedId;
    for (let i = 0; i < 20 && ctx.serviceWorkers().length === 0; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const [sw] = ctx.serviceWorkers();
    if (sw) {
      extOrigin = 'chrome-extension://' + new URL(sw.url()).host;
    }
  }

  await page.goto('https://developer.microsoft.com/en-us/graph/graph-explorer', {
    waitUntil: 'domcontentloaded'
  });

  // 1. Panel embeds into #response-area, splitting it.
  await page.waitForFunction(() => {
    const host = document.getElementById('gejq-host');
    return host && host.parentElement && host.parentElement.id === 'response-area';
  }, { timeout: 10000 });
  check('panel embedded inside #response-area', true);

  const split = await page.evaluate(() => {
    const area = document.getElementById('response-area');
    const host = document.getElementById('gejq-host');
    const ge = document.getElementById('ge-response');
    return {
      display: getComputedStyle(area).display,
      hostWidth: host.getBoundingClientRect().width,
      geWidth: ge.getBoundingClientRect().width,
      areaWidth: area.getBoundingClientRect().width
    };
  });
  check('results area is a flex row', split.display === 'flex');
  check(
    'split is roughly half/half',
    Math.abs(split.hostWidth - split.geWidth) < split.areaWidth * 0.1,
    `ge=${Math.round(split.geWidth)} ext=${Math.round(split.hostWidth)}`
  );

  const panel = page.locator('.gejq-panel');
  check('panel visible by default', await panel.isVisible());

  // Query input must sit above the results box (vertical split).
  const layout = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const input = shadow.querySelector('.gejq-query-input').getBoundingClientRect();
    const result = shadow.querySelector('.gejq-result').getBoundingClientRect();
    return { inputBottom: input.bottom, resultTop: result.top };
  });
  check('query input sits above results', layout.inputBottom <= layout.resultTop + 1);

  // 2. Run a "Graph query" in the fixture; interceptor must capture it.
  await page.evaluate(() => window.runGraphQuery());
  await page.waitForFunction(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const select = shadow.querySelector('.gejq-history-select');
    return select && !select.disabled && select.options.length === 1;
  }, { timeout: 10000 });
  check('graph response captured into history', true);

  // 3. Type a JMESPath query, verify the live result.
  const query = page.locator('.gejq-query-input');
  await query.fill('value[].{name: displayName, email: mail}');
  await page.waitForTimeout(400);
  const resultText = await page.locator('.gejq-result').innerText();
  check('reshape query returns expected data', resultText.includes('adele@contoso.com') && resultText.includes('"name"'));

  await query.fill("value[?jobTitle == 'Auditor'].displayName");
  await page.waitForTimeout(400);
  check('filter query works', (await page.locator('.gejq-result').innerText()).includes('Megan Bowen'));

  await query.fill('value[].displayName)))');
  await page.waitForTimeout(400);
  check('syntax error surfaced', (await page.locator('.gejq-panel .gejq-error').first().innerText()).length > 0);

  await query.fill('value[].displayName');
  await page.waitForTimeout(400);
  const exportState = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const read = (sel) => {
      const node = shadow.querySelector(sel);
      return { disabled: node.disabled, active: node.classList.contains('gejq-seg-active') };
    };
    return {
      json: read('.gejq-seg-btn:first-child'),
      csv: read('.gejq-seg-btn:last-child'),
      copy: shadow.querySelectorAll('.gejq-footer .gejq-action')[0].disabled,
      download: shadow.querySelectorAll('.gejq-footer .gejq-action')[1].disabled
    };
  });
  check('JSON format active by default', exportState.json.active && !exportState.json.disabled);
  check('CSV toggle enabled for CSV-able result', !exportState.csv.disabled);
  check('Copy/Download enabled', !exportState.copy && !exportState.download);

  // Switch to CSV; a scalar result should then disable exports.
  await page.locator('.gejq-seg-btn', { hasText: 'CSV' }).click();
  const csvActive = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    return shadow.querySelector('.gejq-seg-btn:last-child').classList.contains('gejq-seg-active');
  });
  check('CSV format selectable', csvActive);

  await query.fill('length(value)');
  await page.waitForTimeout(400);
  const scalarCsv = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    return {
      csvDisabled: shadow.querySelector('.gejq-seg-btn:last-child').disabled,
      copyDisabled: shadow.querySelectorAll('.gejq-footer .gejq-action')[0].disabled
    };
  });
  check('CSV disabled for non-CSV-able result', scalarCsv.csvDisabled && scalarCsv.copyDisabled);
  await page.locator('.gejq-seg-btn', { hasText: 'JSON' }).click();
  await page.waitForTimeout(200);
  check(
    'switching back to JSON re-enables exports',
    await page.evaluate(() => {
      const shadow = document.getElementById('gejq-host').shadowRoot;
      return !shadow.querySelectorAll('.gejq-footer .gejq-action')[0].disabled;
    })
  );
  await query.fill('value[].displayName');
  await page.waitForTimeout(400);

  const meta = await page.locator('.gejq-meta').innerText();
  check('meta line describes result', meta.includes('array'), meta);

  // Advanced-query setting (default on): leaving the URI field with a
  // $filter query visibly appends $count=true to the field itself (the
  // ConsistencyLevel header goes through GE's Request-headers view,
  // which this fixture doesn't have — the assist must not crash without
  // it). Nothing is rewritten at the network layer.
  await page.evaluate(() => {
    const editor = document.getElementById('ge-editor-input');
    editor.value = "https://graph.microsoft.com/v1.0/users?$filter=startswith(displayName,'a')";
    editor.focus();
  });
  await page.locator('#ge-json').click(); // blur the URI field
  await page.waitForTimeout(400);
  const editorAfterAssist = await page.evaluate(() => document.getElementById('ge-editor-input').value);
  check(
    'advanced query visibly gains $count=true in the URI field',
    editorAfterAssist === "https://graph.microsoft.com/v1.0/users?$filter=startswith(displayName,'a')&$count=true",
    editorAfterAssist
  );
  // The header rows are added through GE's Request-headers view.
  await page.waitForTimeout(800);
  const headerRows = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#ge-header-list li')).map((li) => li.textContent)
  );
  check('ConsistencyLevel added via the headers view', headerRows.includes('ConsistencyLevel: eventual'), headerRows.join(' | '));
  check('Content-Type added via the headers view', headerRows.includes('Content-Type: application/json'), headerRows.join(' | '));
  check(
    'previous tab restored after adding headers',
    await page.evaluate(() => document.getElementById('fake-body-tab').getAttribute('aria-selected') === 'true')
  );
  await page.locator('#ge-run').click(); // run it — the field content is what goes out
  await page.waitForTimeout(400);
  const advReq = graphRequests.find((r) => r.url.includes('%24filter') || r.url.includes('$filter'));
  check('the visible $count=true is what got sent', !!advReq && /[$%]24count=true|\$count=true/.test(advReq.url), advReq && advReq.url);
  check('no hidden header was injected', !!advReq && advReq.headers['consistencylevel'] === undefined);
  const plainReq = graphRequests.find((r) => r.url.includes('$top=3'));
  check('plain query left untouched', !!plainReq && !plainReq.url.includes('count') && plainReq.headers['consistencylevel'] === undefined);
  // A plain query must not be touched when leaving the field either.
  await page.evaluate(() => {
    const editor = document.getElementById('ge-editor-input');
    editor.value = 'https://graph.microsoft.com/v1.0/users?$top=3';
    editor.focus();
  });
  await page.locator('#ge-json').click();
  await page.waitForTimeout(300);
  check(
    'plain query URI field not touched by the assist',
    (await page.evaluate(() => document.getElementById('ge-editor-input').value)) === 'https://graph.microsoft.com/v1.0/users?$top=3'
  );

  // Auto sign-in: the fixture's profile-view button must get clicked once.
  check('auto sign-in clicked the profile view', (await page.evaluate(() => window.__signInClicks)) === 1);

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, 'embedded.png') });

  // 4. Collapse via ✕ — GE view reclaims full width, FAB appears.
  await page.locator('.gejq-close').click();
  await page.waitForTimeout(300);
  const collapsed = await page.evaluate(() => {
    const host = document.getElementById('gejq-host');
    const shadow = host.shadowRoot;
    return {
      panelVisible: shadow.querySelector('.gejq-panel').offsetParent !== null,
      fabVisible: !shadow.querySelector('.gejq-fab').classList.contains('gejq-hidden'),
      geWidth: document.getElementById('ge-response').getBoundingClientRect().width,
      areaWidth: document.getElementById('response-area').getBoundingClientRect().width
    };
  });
  check('collapse hides panel', !collapsed.panelVisible);
  check('collapse shows FAB', collapsed.fabVisible);
  check('GE view reclaims full width', collapsed.geWidth > collapsed.areaWidth * 0.9);

  // 5. FAB re-opens the panel.
  await page.locator('.gejq-fab').click();
  await page.waitForTimeout(300);
  check('FAB re-opens panel', await panel.isVisible());

  // 6. Paste JSON flow.
  await page.locator('.gejq-icon-button', { hasText: 'Paste JSON' }).click();
  await page.locator('.gejq-paste-input').fill('{"value":[{"displayName":"Pasted Person","mail":"p@x.com"}]}');
  await page.locator('.gejq-action.gejq-primary').click();
  await query.fill('value[0].mail');
  await page.waitForTimeout(400);
  check('paste JSON flow works', (await page.locator('.gejq-result').innerText()).includes('p@x.com'));

  // 7. Popup page: settings controls drive the panel live.
  check('extension origin discovered', typeof extOrigin === 'string' && extOrigin.startsWith('chrome-extension://'), extOrigin);
  const popup = await ctx.newPage();
  await popup.goto(extOrigin + '/popup/popup.html');
  check('popup shows settings controls', (await popup.locator('#setting-language').count()) === 1);
  await popup.selectOption('#setting-language', 'jsonpath');
  await popup.check('#setting-auto-fetch');
  await page.waitForTimeout(500);
  const panelLanguage = await page.evaluate(
    () => document.getElementById('gejq-host').shadowRoot.querySelector('.gejq-lang-select').value
  );
  check('panel language synced from popup', panelLanguage === 'jsonpath');

  // 8. JSONPath queries work after the switch.
  await query.fill('$.value[*].mail');
  await page.waitForTimeout(400);
  check('JSONPath query works', (await page.locator('.gejq-result').innerText()).includes('p@x.com'));

  // 9. Enter records the query into the persistent history with timestamp + context.
  await query.press('Enter');
  await page.waitForTimeout(300);
  const historyRow = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const rows = shadow.querySelectorAll('.gejq-query-history .gejq-example');
    return rows.length ? rows[0].textContent : null;
  });
  check('query recorded in history with timestamp', !!historyRow && /\d\d:\d\d/.test(historyRow), historyRow);

  // 10. Auto-fetch nextLink aggregates all pages into one dataset.
  await page.evaluate(() => window.runGraphQuery('/v1.0/users?paged=1'));
  try {
    await page.waitForFunction(
      () => {
        const shadow = document.getElementById('gejq-host').shadowRoot;
        const options = shadow.querySelectorAll('.gejq-history-select option');
        return Array.from(options).some((o) => o.textContent.includes('3 pages') && !o.textContent.includes('incomplete'));
      },
      { timeout: 10000 }
    );
    check('auto-fetch aggregated 3 pages into one entry', true);
  } catch (e) {
    check('auto-fetch aggregated 3 pages into one entry', false, e.message.split('\n')[0]);
  }
  await query.fill('$.value.length');
  await page.waitForTimeout(400);
  check('aggregated dataset holds all 9 items', (await page.locator('.gejq-result').innerText()).trim().includes('9'));
  check('no truncation warning under the limits', (await page.locator('.gejq-warning').innerText()).trim() === '');

  // 10b. "Load ↗" re-populates the (mock) Graph Explorer request editor.
  await query.press('Enter'); // record with context = the aggregated GET
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    shadow.querySelector('.gejq-query-history .gejq-load').click();
  });
  await page.waitForTimeout(200);
  const editorValue = await page.evaluate(() => document.getElementById('ge-editor-input').value);
  check(
    'Load button re-populates the request editor in place',
    editorValue === 'https://graph.microsoft.com/v1.0/users?paged=1',
    editorValue
  );
  check('no page reload happened (in-place path)', !page.url().includes('request='), page.url());

  // 10c. Lowering the auto-fetch page limit truncates and warns.
  await popup.fill('#setting-auto-fetch-pages', '2');
  await popup.dispatchEvent('#setting-auto-fetch-pages', 'change');
  await page.waitForTimeout(500);
  await page.evaluate(() => window.runGraphQuery('/v1.0/users?paged=1'));
  try {
    await page.waitForFunction(
      () => {
        const shadow = document.getElementById('gejq-host').shadowRoot;
        const options = shadow.querySelectorAll('.gejq-history-select option');
        return Array.from(options).some((o) => o.textContent.includes('2 pages, incomplete'));
      },
      { timeout: 10000 }
    );
    check('lowered page limit marks the entry incomplete', true);
  } catch (e) {
    check('lowered page limit marks the entry incomplete', false, e.message.split('\n')[0]);
  }
  const warningText = await page.locator('.gejq-warning').innerText();
  check('truncation warning shown to the user', /incomplete|stopped early/i.test(warningText), warningText.slice(0, 90));

  // 10d. Switching languages auto-converts simple queries.
  await query.fill('$.value[*].displayName');
  await page.waitForTimeout(300);
  await page.locator('.gejq-lang-select').selectOption('jmespath');
  await page.waitForTimeout(400);
  check('language switch converts the query', (await query.inputValue()) === 'value[].displayName', await query.inputValue());
  check('converted query runs without error', (await page.locator('.gejq-panel .gejq-error').first().innerText()).trim() === '');
  check('converted query returns data', (await page.locator('.gejq-result').innerText()).includes('Nestor Wilke'));

  // 10e. Unconvertible queries keep their text, but suggestions follow
  // the new language even while the query errors: `$..displayName` has
  // no JMESPath equivalent and errors there as a syntax error.
  await page.locator('.gejq-lang-select').selectOption('jsonpath');
  await query.fill('$..displayName');
  await page.waitForTimeout(300);
  await page.locator('.gejq-lang-select').selectOption('jmespath');
  await page.waitForTimeout(400);
  check('unconvertible query left untouched', (await query.inputValue()) === '$..displayName');
  check('error shown for incompatible query', (await page.locator('.gejq-panel .gejq-error').first().innerText()).trim() !== '');
  const chipTexts = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    return Array.from(shadow.querySelectorAll('.gejq-suggestions .gejq-chip')).map((c) => c.textContent);
  });
  check('suggestions refreshed to new language despite error', chipTexts.length > 0 && chipTexts.every((c) => !c.startsWith('$')), chipTexts.join(' | '));

  // 10f. jq engine.
  await page.locator('.gejq-lang-select').selectOption('jq');
  await query.fill('.value | length');
  await page.waitForTimeout(400);
  check('jq count query works', (await page.locator('.gejq-result').innerText()).trim().includes('6'));
  await query.fill('.value[].displayName');
  await page.waitForTimeout(400);
  check('jq iteration query works', (await page.locator('.gejq-result').innerText()).includes('Lidia Holloway'));

  // 10f2. Tier-2 autocomplete: property names from the selected response.
  await query.fill('.value[].ma');
  await page.waitForTimeout(300);
  const propItems = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const list = shadow.querySelector('.gejq-autocomplete');
    return list.style.display === 'none'
      ? null
      : Array.from(list.querySelectorAll('.gejq-ac-label')).map((l) => l.textContent);
  });
  check('property completion offers response keys', !!propItems && propItems.includes('mail'), (propItems || []).join(' | '));
  await query.press('Enter');
  await page.waitForTimeout(200);
  check('accepting property completion builds the path', (await query.inputValue()) === '.value[].mail', await query.inputValue());

  // Tier-1 autocomplete: language builtins.
  await query.fill('.value | uniq');
  await page.waitForTimeout(300);
  const acItems = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const list = shadow.querySelector('.gejq-autocomplete');
    return list.style.display === 'none'
      ? null
      : Array.from(list.querySelectorAll('.gejq-ac-label')).map((l) => l.textContent);
  });
  check('autocomplete dropdown offers matching builtins', !!acItems && acItems.includes('unique') && acItems.includes('unique_by('), (acItems || []).join(' | '));
  await query.press('ArrowDown');
  await query.press('Enter');
  await page.waitForTimeout(200);
  check('ArrowDown+Enter accepts the highlighted completion', (await query.inputValue()) === '.value | unique', await query.inputValue());
  check(
    'dropdown closes after accepting',
    await page.evaluate(() => document.getElementById('gejq-host').shadowRoot.querySelector('.gejq-autocomplete').style.display === 'none')
  );
  await query.fill('.value | so');
  await page.waitForTimeout(300);
  await query.press('Escape');
  const escState = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    return {
      dropdownHidden: shadow.querySelector('.gejq-autocomplete').style.display === 'none',
      panelVisible: shadow.querySelector('.gejq-panel').offsetParent !== null
    };
  });
  check('Escape closes the dropdown but not the panel', escState.dropdownHidden && escState.panelVisible, JSON.stringify(escState));
  await query.fill('.value[].displayName');
  await page.waitForTimeout(400);

  // 10g. CSV toggle switches the output view itself.
  await page.locator('.gejq-seg-btn', { hasText: 'CSV' }).click();
  await page.waitForTimeout(300);
  const csvView = await page.locator('.gejq-result').innerText();
  check('CSV view renders CSV text', csvView.startsWith('value') && csvView.includes('Adele Vance'), csvView.slice(0, 40));
  check('meta marks CSV view', (await page.locator('.gejq-meta').innerText()).includes('CSV view'));
  await page.locator('.gejq-seg-btn', { hasText: 'JSON' }).click();
  await page.waitForTimeout(200);
  check('JSON view restored', (await page.locator('.gejq-result').innerText()).trim().startsWith('['));

  // 10h. Response row: full selectable text with timestamp, URL, status,
  // and the inline live indicator.
  const info = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    return {
      badge: shadow.querySelector('.gejq-live-badge').textContent,
      text: shadow.querySelector('.gejq-response-text').value
    };
  });
  check('response row shows live badge inline', info.badge.includes('live'), info.badge);
  check(
    'response row combines timestamp, full URL, and status',
    /^\d\d:\d\d:\d\d · GET https:\/\/graph\.microsoft\.com\/v1\.0\/users\?paged=1 → 200/.test(info.text),
    info.text
  );
  await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const select = shadow.querySelector('.gejq-history-select');
    select.value = select.options[1].value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(200);
  check(
    'pinned badge when an older response is selected',
    await page.evaluate(() => document.getElementById('gejq-host').shadowRoot.querySelector('.gejq-live-badge').textContent.includes('pinned'))
  );
  await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const select = shadow.querySelector('.gejq-history-select');
    select.value = select.options[0].value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(200);

  // 10i. Star and tag grouping in the query history.
  await query.fill('.value[].displayName');
  await query.press('Enter');
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    shadow.querySelector('.gejq-query-history .gejq-star').click();
  });
  await page.waitForTimeout(200);
  await query.fill('.value | length');
  await query.press('Enter');
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const rows = shadow.querySelectorAll('.gejq-query-history .gejq-example');
    for (const row of rows) {
      const star = row.querySelector('.gejq-star');
      if (star && !star.classList.contains('gejq-starred')) {
        row.querySelector('.gejq-icon-mini').click();
        return;
      }
    }
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const input = shadow.querySelector('.gejq-tag-input');
    input.value = 'counts';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await page.waitForTimeout(300);
  const historyState = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    return {
      headings: Array.from(shadow.querySelectorAll('.gejq-query-history .gejq-help-heading')).map((h) => h.textContent),
      rowMetas: Array.from(shadow.querySelectorAll('.gejq-query-history .gejq-example-label')).map((s) => s.textContent)
    };
  });
  check('favorites group pinned first', historyState.headings[0] === '★ Favorites', historyState.headings.join(' | '));
  check('no per-tag groups (tags shown inline)', !historyState.headings.includes('counts') && historyState.rowMetas.some((m) => m.includes('#counts')), historyState.headings.join(' | '));

  // 10i2. History filtering: free text, tag chips.
  await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    shadow.querySelectorAll('details').forEach((d) => {
      if (d.querySelector('.gejq-hist-filter-text')) {
        d.open = true; // expand the history section so the filter bar is interactable
      }
    });
  });
  const rowsBefore = await page.evaluate(
    () => document.getElementById('gejq-host').shadowRoot.querySelectorAll('.gejq-query-history .gejq-example').length
  );
  await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const chip = Array.from(shadow.querySelectorAll('.gejq-hist-tags .gejq-chip')).find((c) => c.textContent === '#counts');
    chip.click();
  });
  await page.waitForTimeout(200);
  const tagFiltered = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    return {
      rows: shadow.querySelectorAll('.gejq-query-history .gejq-example').length,
      summary: shadow.querySelectorAll('.gejq-panel details summary')[0] ? Array.from(shadow.querySelectorAll('.gejq-panel details summary')).map((s) => s.textContent).find((t) => t.startsWith('Query history')) : ''
    };
  });
  check('tag chip filters the history', tagFiltered.rows === 1 && tagFiltered.rows < rowsBefore, `rows ${rowsBefore} → ${tagFiltered.rows}, ${tagFiltered.summary}`);
  check('summary shows filtered/total count', /\(\d+\/\d+\)/.test(tagFiltered.summary), tagFiltered.summary);
  await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    Array.from(shadow.querySelectorAll('.gejq-hist-tags .gejq-chip')).find((c) => c.textContent === '#counts').click();
  });
  await page.waitForTimeout(200);
  const filterInput = page.locator('.gejq-hist-filter-text');
  await filterInput.fill('displayName');
  await page.waitForTimeout(200);
  const textFiltered = await page.evaluate(
    () => document.getElementById('gejq-host').shadowRoot.querySelectorAll('.gejq-query-history .gejq-example').length
  );
  check('free-text filter narrows the history', textFiltered >= 1 && textFiltered < rowsBefore, `rows ${rowsBefore} → ${textFiltered}`);
  await filterInput.fill('');
  await page.waitForTimeout(200);

  // 10i3. Suggestions section is collapsible.
  const suggestionsCollapsible = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    const details = shadow.querySelector('.gejq-suggestions-details');
    return {
      isDetails: details && details.tagName === 'DETAILS' && details.open,
      summaryText: details ? details.querySelector('summary').textContent : ''
    };
  });
  check(
    'suggestions live in an open collapsible section',
    suggestionsCollapsible.isDetails && suggestionsCollapsible.summaryText === 'Suggested for this response',
    JSON.stringify(suggestionsCollapsible)
  );

  // 10j. The split between response view and panel is draggable.
  const hostWidthBefore = await page.evaluate(() => document.getElementById('gejq-host').getBoundingClientRect().width);
  const resizerBox = await page.locator('.gejq-resizer').boundingBox();
  check('resizer present in embedded mode', !!resizerBox);
  if (resizerBox) {
    await page.mouse.move(resizerBox.x + resizerBox.width / 2, resizerBox.y + 100);
    await page.mouse.down();
    await page.mouse.move(resizerBox.x - 150, resizerBox.y + 100, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const hostWidthAfter = await page.evaluate(() => document.getElementById('gejq-host').getBoundingClientRect().width);
    check('dragging the divider widens the panel', hostWidthAfter > hostWidthBefore + 100, `${Math.round(hostWidthBefore)} → ${Math.round(hostWidthAfter)}`);
  }

  // 10k. Query input starts as tall as the language selector.
  const inputHeights = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    return {
      input: shadow.querySelector('.gejq-query-input').getBoundingClientRect().height,
      select: shadow.querySelector('.gejq-lang-select').getBoundingClientRect().height
    };
  });
  check('query input matches language selector height', Math.abs(inputHeights.input - inputHeights.select) <= 2, JSON.stringify(inputHeights));

  // 10l. Graph Explorer's own background calls are hidden behind a toggle.
  const optionCountBefore = await page.evaluate(
    () => document.getElementById('gejq-host').shadowRoot.querySelectorAll('.gejq-history-select option').length
  );
  // Internal-style call: URL not in the URI field, no run interaction.
  await page.evaluate(() => fetch('https://graph.microsoft.com/v1.0/organization').then((r) => r.json()));
  await page.waitForTimeout(600);
  const bgState = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    return {
      options: shadow.querySelectorAll('.gejq-history-select option').length
    };
  });
  check('background request hidden from the response list', bgState.options === optionCountBefore, `options ${optionCountBefore} → ${bgState.options}`);
  await popup.check('#setting-show-background');
  await page.waitForTimeout(500);
  const shownBg = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    return Array.from(shadow.querySelectorAll('.gejq-history-select option')).map((o) => o.textContent);
  });
  check('settings toggle reveals background entry with ⚙ marker', shownBg.some((t) => t.includes('⚙') && t.includes('/v1.0/organization')), shownBg.find((t) => t.includes('⚙')));
  await popup.uncheck('#setting-show-background');
  await page.waitForTimeout(500);
  const hiddenAgain = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    return Array.from(shadow.querySelectorAll('.gejq-history-select option')).every((o) => !o.textContent.includes('⚙'));
  });
  check('unchecking the setting hides background entries again', hiddenAgain);

  // A deliberate run of a "background-looking" URL (via the Run button)
  // stays visible: URI field matches + recent run interaction.
  await page.evaluate(() => {
    document.getElementById('ge-editor-input').value = 'https://graph.microsoft.com/v1.0/me';
  });
  await page.locator('#ge-run').click();
  await page.waitForTimeout(600);
  const meVisible = await page.evaluate(() => {
    const shadow = document.getElementById('gejq-host').shadowRoot;
    return Array.from(shadow.querySelectorAll('.gejq-history-select option')).map((o) => o.textContent);
  });
  check(
    'deliberately-run GET /me stays visible',
    meVisible.some((t) => t.includes('/v1.0/me') && !t.includes('⚙')),
    meVisible[0]
  );

  // 11. Re-opening the popup within the double-click window opens Graph Explorer.
  const tabsBefore = ctx.pages().length;
  const popupA = await ctx.newPage();
  await popupA.goto(extOrigin + '/popup/popup.html');
  // A second popup open within the double-click window opens Graph
  // Explorer (chrome.tabs.create — verified to return a tab id, but the
  // created tab is invisible to Playwright's tracker in headless mode)
  // and then self-closes. The self-close is the observable signal that
  // the double-open was detected and handled.
  await popupA.waitForTimeout(250); // human double-click gap; lets the first open's timestamp land
  await popupA.reload().catch(() => {});
  let selfClosed = false;
  for (let i = 0; i < 20 && !selfClosed; i++) {
    await new Promise((r) => setTimeout(r, 200));
    selfClosed = popupA.isClosed();
  }
  check(
    'double-open popup detected (opens Graph Explorer and closes itself)',
    selfClosed,
    `pages before=${tabsBefore} after=${ctx.pages().length}`
  );

  // 12. Simulate a React remount wiping the results area — panel must re-embed.
  await page.evaluate(() => {
    const area = document.getElementById('response-area');
    area.remove();
    const fresh = document.createElement('div');
    fresh.id = 'response-area';
    const inner = document.createElement('div');
    inner.id = 'ge-response';
    inner.textContent = 'fresh response view';
    fresh.appendChild(inner);
    document.getElementById('app').appendChild(fresh);
  });
  await page.waitForFunction(() => {
    const host = document.getElementById('gejq-host');
    return host && host.parentElement && host.parentElement.id === 'response-area';
  }, { timeout: 5000 });
  check('panel re-embeds after results area remount', true);

  await page.screenshot({ path: path.join(SHOT_DIR, 'after-remount.png') });
  await ctx.close();
  fs.rmSync(profileDir, { recursive: true, force: true });

  console.log(failures === 0 ? '\nSMOKE TEST PASSED' : `\nSMOKE TEST: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('SMOKE TEST CRASHED:', e.message);
  process.exit(1);
});
