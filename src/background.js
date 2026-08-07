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
});
