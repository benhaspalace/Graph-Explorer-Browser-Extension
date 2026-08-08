'use strict';

var STORAGE_KEY_SETTINGS = 'gejq.settings';
var GRAPH_EXPLORER_URL = 'https://developer.microsoft.com/en-us/graph/graph-explorer';
var DOUBLE_CLICK_WINDOW_MS = 800;

var languageSelect = document.getElementById('setting-language');
var advancedQueryBox = document.getElementById('setting-advanced-query');
var autoSignInBox = document.getElementById('setting-auto-sign-in');
var autoFetchBox = document.getElementById('setting-auto-fetch');
var autoFetchPagesInput = document.getElementById('setting-auto-fetch-pages');
var autoFetchMbInput = document.getElementById('setting-auto-fetch-mb');
var showBackgroundBox = document.getElementById('setting-show-background');
var historyLimitInput = document.getElementById('setting-history-limit');
var historyUnlimitedBox = document.getElementById('setting-history-unlimited');
var openExplorerLink = document.getElementById('open-explorer');

document.getElementById('version').textContent = 'v' + chrome.runtime.getManifest().version;

// Double-clicking the toolbar icon re-opens this popup within a moment of
// the previous open — treat that as "take me to Graph Explorer".
try {
  chrome.storage.session.get(['lastPopupOpen'], function (items) {
    var now = Date.now();
    var last = items && items.lastPopupOpen;
    chrome.storage.session.set({ lastPopupOpen: now });
    if (typeof last === 'number' && now - last < DOUBLE_CLICK_WINDOW_MS) {
      chrome.tabs.create({ url: GRAPH_EXPLORER_URL }, function () {
        window.close();
      });
    }
  });
} catch (e) {
  /* storage.session unavailable — double-click shortcut disabled */
}

// Enter also opens Graph Explorer: the button is focused when the popup opens.
openExplorerLink.focus();

var LANGUAGE_KEYS = ['jmespath', 'jsonpath', 'jq'];

function validLanguage(value) {
  return LANGUAGE_KEYS.indexOf(value) !== -1 ? value : 'jmespath';
}

function render(settings) {
  languageSelect.value = validLanguage(settings.queryLanguage);
  // advancedQuery and autoSignIn default to on; autoFetchNextLink to off.
  advancedQueryBox.checked = settings.advancedQuery !== false;
  autoSignInBox.checked = settings.autoSignIn !== false;
  autoFetchBox.checked = settings.autoFetchNextLink === true;
  autoFetchPagesInput.value = String(GEJQ.clampInt(settings.autoFetchMaxPages, 1, 1000, 50));
  autoFetchMbInput.value = String(GEJQ.clampInt(settings.autoFetchMaxMb, 1, 50, 10));
  showBackgroundBox.checked = settings.showBackgroundRequests === true;
  var limit = typeof settings.historyLimit === 'number' && settings.historyLimit >= 0 ? settings.historyLimit : 50;
  historyUnlimitedBox.checked = limit === 0;
  historyLimitInput.disabled = limit === 0;
  historyLimitInput.value = limit === 0 ? '' : String(limit);
}

chrome.storage.local.get([STORAGE_KEY_SETTINGS], function (items) {
  render(items[STORAGE_KEY_SETTINGS] || {});
});

function save() {
  var limit;
  if (historyUnlimitedBox.checked) {
    limit = 0; // unlimited
  } else {
    limit = GEJQ.clampInt(historyLimitInput.value, 1, 10000, 50);
  }
  historyLimitInput.disabled = historyUnlimitedBox.checked;
  // Re-read before writing: the panel can change settings (e.g. the
  // query language) while this popup is open, and a stale snapshot
  // would silently overwrite them.
  chrome.storage.local.get([STORAGE_KEY_SETTINGS], function (items) {
    var settings = items[STORAGE_KEY_SETTINGS] || {};
    settings.queryLanguage = validLanguage(languageSelect.value);
    settings.advancedQuery = advancedQueryBox.checked;
    settings.autoSignIn = autoSignInBox.checked;
    settings.autoFetchNextLink = autoFetchBox.checked;
    settings.autoFetchMaxPages = GEJQ.clampInt(autoFetchPagesInput.value, 1, 1000, 50);
    settings.autoFetchMaxMb = GEJQ.clampInt(autoFetchMbInput.value, 1, 50, 10);
    settings.showBackgroundRequests = showBackgroundBox.checked;
    settings.historyLimit = limit;
    var toStore = {};
    toStore[STORAGE_KEY_SETTINGS] = settings;
    chrome.storage.local.set(toStore);
  });
}

languageSelect.addEventListener('change', save);
advancedQueryBox.addEventListener('change', save);
autoSignInBox.addEventListener('change', save);
autoFetchBox.addEventListener('change', save);
autoFetchPagesInput.addEventListener('change', save);
autoFetchMbInput.addEventListener('change', save);
showBackgroundBox.addEventListener('change', save);
historyLimitInput.addEventListener('change', save);
historyUnlimitedBox.addEventListener('change', save);
