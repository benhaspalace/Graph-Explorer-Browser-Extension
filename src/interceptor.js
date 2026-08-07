/**
 * Graph Explorer JSON Query — network interceptor.
 *
 * Runs in the page's MAIN world (document_start) so it can wrap
 * window.fetch / XMLHttpRequest before the Graph Explorer app boots.
 * Every JSON response coming back from a Microsoft Graph endpoint is
 * forwarded to the extension's content script via window.postMessage.
 *
 * Nothing here leaves the browser: messages stay within the page.
 */
(function () {
  'use strict';

  if (window.__gejqInterceptorInstalled) {
    return;
  }
  window.__gejqInterceptorInstalled = true;

  var MESSAGE_SOURCE = 'gejq-interceptor';
  var MAX_BODY_CHARS = 10 * 1024 * 1024; // 10 MB of JSON text is plenty
  var GRAPH_HOSTS = [
    'graph.microsoft.com',
    'graph.microsoft.us',
    'dod-graph.microsoft.us',
    'microsoftgraph.chinacloudapi.cn',
    'graph.microsoft.de'
  ];

  var idCounter = 0;

  function isGraphHost(hostname) {
    var h = String(hostname || '').toLowerCase();
    for (var i = 0; i < GRAPH_HOSTS.length; i++) {
      if (h === GRAPH_HOSTS[i] || h.slice(-(GRAPH_HOSTS[i].length + 1)) === '.' + GRAPH_HOSTS[i]) {
        return true;
      }
    }
    return false;
  }

  /**
   * Returns the Graph API URL a request targets, or null if it is not a
   * Graph request. Handles both direct calls and Graph Explorer's
   * anonymous-mode proxy (…/proxy?url=<encoded graph url>).
   */
  function resolveGraphUrl(rawUrl) {
    try {
      var u = new URL(rawUrl, window.location.href);
      if (isGraphHost(u.hostname)) {
        return u.href;
      }
      var inner = u.searchParams.get('url');
      if (inner) {
        var innerUrl = new URL(inner);
        if (isGraphHost(innerUrl.hostname)) {
          return innerUrl.href;
        }
      }
    } catch (e) {
      /* not a parseable URL — ignore */
    }
    return null;
  }

  function post(payload) {
    try {
      window.postMessage({ source: MESSAGE_SOURCE, type: 'graph-response', payload: payload }, window.location.origin);
    } catch (e) {
      /* payload not cloneable — ignore */
    }
  }

  function makeEntry(method, url, status) {
    idCounter += 1;
    return {
      id: Date.now() + '-' + idCounter,
      method: String(method || 'GET').toUpperCase(),
      url: url,
      status: status,
      timestamp: Date.now()
    };
  }

  function handleBodyText(text, method, url, status) {
    if (typeof text !== 'string' || text.length === 0) {
      return;
    }
    var entry = makeEntry(method, url, status);
    if (text.length > MAX_BODY_CHARS) {
      entry.tooLarge = true;
      entry.size = text.length;
      post(entry);
      return;
    }
    var trimmed = text.replace(/^\uFEFF/, '').trim();
    if (trimmed[0] !== '{' && trimmed[0] !== '[') {
      return; // not JSON (binary, HTML error page, …)
    }
    var json;
    try {
      json = JSON.parse(trimmed);
    } catch (e) {
      return;
    }
    entry.json = json;
    entry.size = text.length;
    post(entry);
  }

  // ---- fetch ----
  var originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (input, init) {
      var result = originalFetch.apply(this, arguments);
      try {
        var rawUrl =
          typeof input === 'string'
            ? input
            : input && typeof input.url === 'string'
              ? input.url
              : String(input);
        var graphUrl = resolveGraphUrl(rawUrl);
        if (graphUrl) {
          var method =
            (init && init.method) ||
            (input && typeof input === 'object' && input.method) ||
            'GET';
          result
            .then(function (response) {
              try {
                var contentType = (response.headers && response.headers.get('content-type')) || '';
                if (contentType && !/json|text/i.test(contentType)) {
                  return; // images, binary streams, …
                }
                response
                  .clone()
                  .text()
                  .then(function (text) {
                    handleBodyText(text, method, graphUrl, response.status);
                  })
                  .catch(function () {});
              } catch (e) {
                /* ignore */
              }
            })
            .catch(function () {});
        }
      } catch (e) {
        /* never break the page's fetch */
      }
      return result;
    };
  }

  // ---- XMLHttpRequest (belt and braces; Graph Explorer mainly uses fetch) ----
  var XhrProto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XhrProto) {
    var originalOpen = XhrProto.open;
    var originalSend = XhrProto.send;
    XhrProto.open = function (method, url) {
      try {
        this.__gejqRequest = { method: method, url: url };
      } catch (e) {
        /* ignore */
      }
      return originalOpen.apply(this, arguments);
    };
    XhrProto.send = function () {
      var info = this.__gejqRequest;
      if (info) {
        var graphUrl = resolveGraphUrl(info.url);
        if (graphUrl) {
          var xhr = this;
          xhr.addEventListener('load', function () {
            try {
              if (xhr.responseType === '' || xhr.responseType === 'text') {
                handleBodyText(xhr.responseText, info.method, graphUrl, xhr.status);
              } else if (xhr.responseType === 'json' && xhr.response !== null && typeof xhr.response === 'object') {
                var entry = makeEntry(info.method, graphUrl, xhr.status);
                entry.json = xhr.response;
                post(entry);
              }
            } catch (e) {
              /* ignore */
            }
          });
        }
      }
      return originalSend.apply(this, arguments);
    };
  }
})();
