'use strict';

var STORAGE_KEY_SETTINGS = 'gejq.settings';
var GRAPH_EXPLORER_URL = 'https://developer.microsoft.com/en-us/graph/graph-explorer';
var DOUBLE_CLICK_WINDOW_MS = 800;

var languageSelect = document.getElementById('setting-language');
var advancedQueryBox = document.getElementById('setting-advanced-query');
var autoSignInBox = document.getElementById('setting-auto-sign-in');
var autoFetchBox = document.getElementById('setting-auto-fetch');
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

var settings = {};

chrome.storage.local.get([STORAGE_KEY_SETTINGS], function (items) {
  settings = items[STORAGE_KEY_SETTINGS] || {};
  languageSelect.value = settings.queryLanguage === 'jsonpath' ? 'jsonpath' : 'jmespath';
  // advancedQuery and autoSignIn default to on; autoFetchNextLink to off.
  advancedQueryBox.checked = settings.advancedQuery !== false;
  autoSignInBox.checked = settings.autoSignIn !== false;
  autoFetchBox.checked = settings.autoFetchNextLink === true;
  var limit = typeof settings.historyLimit === 'number' && settings.historyLimit >= 0 ? settings.historyLimit : 50;
  historyUnlimitedBox.checked = limit === 0;
  historyLimitInput.disabled = limit === 0;
  historyLimitInput.value = limit === 0 ? '' : String(limit);
});

function save() {
  var limit;
  if (historyUnlimitedBox.checked) {
    limit = 0; // unlimited
  } else {
    limit = parseInt(historyLimitInput.value, 10);
    if (!isFinite(limit) || limit < 1) {
      limit = 50;
    }
  }
  historyLimitInput.disabled = historyUnlimitedBox.checked;
  settings.queryLanguage = languageSelect.value === 'jsonpath' ? 'jsonpath' : 'jmespath';
  settings.advancedQuery = advancedQueryBox.checked;
  settings.autoSignIn = autoSignInBox.checked;
  settings.autoFetchNextLink = autoFetchBox.checked;
  settings.historyLimit = limit;
  var items = {};
  items[STORAGE_KEY_SETTINGS] = settings;
  chrome.storage.local.set(items);
}

languageSelect.addEventListener('change', save);
advancedQueryBox.addEventListener('change', save);
autoSignInBox.addEventListener('change', save);
autoFetchBox.addEventListener('change', save);
historyLimitInput.addEventListener('change', save);
historyUnlimitedBox.addEventListener('change', save);
