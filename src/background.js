/**
 * Graph Explorer JSON Query — background service worker.
 *
 * Handles the "open-graph-explorer" keyboard command (Alt+G by default)
 * by opening Graph Explorer in a new tab.
 */
'use strict';

var GRAPH_EXPLORER_URL = 'https://developer.microsoft.com/en-us/graph/graph-explorer';

chrome.commands.onCommand.addListener(function (command) {
  if (command === 'open-graph-explorer') {
    chrome.tabs.create({ url: GRAPH_EXPLORER_URL });
  }
  if (command === 'focus-query-input') {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (tabs && tabs[0] && typeof tabs[0].id === 'number') {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'gejq-focus-query' }, function () {
          void chrome.runtime.lastError; // no receiver on non-GE tabs — fine
        });
      }
    });
  }
});
