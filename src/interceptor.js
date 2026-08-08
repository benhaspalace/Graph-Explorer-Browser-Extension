/**
 * Graph Explorer JSON Query — network interceptor.
 *
 * Runs in the page's MAIN world (document_start) so it can wrap
 * window.fetch / XMLHttpRequest before the Graph Explorer app boots.
 * Every JSON response coming back from a Microsoft Graph endpoint is
 * forwarded to the extension's content script via window.postMessage.
 *
 * This script only observes requests (and, for the opt-in auto-fetch
 * feature, follows @odata.nextLink pages). It never modifies the
 * queries Graph Explorer sends: the advanced-queries assistance happens
 * visibly in Graph Explorer's own UI (see content.js).
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
  var SETTINGS_SOURCE = 'gejq-settings';
  var MAX_BODY_CHARS = 10 * 1024 * 1024; // 10 MB of JSON text is plenty
  var GRAPH_HOSTS = [
    'graph.microsoft.com',
    'graph.microsoft.us',
    'dod-graph.microsoft.us',
    'microsoftgraph.chinacloudapi.cn',
    'graph.microsoft.de'
  ];

  var idCounter = 0;

  // Defaults match the extension's stored defaults; the content script
  // pushes the user's actual settings in shortly after page load.
  var settings = {
    autoFetchNextLink: false,
    autoFetchMaxPages: 50,
    autoFetchMaxChars: 10 * 1024 * 1024
  };

  window.addEventListener('message', function (event) {
    if (event.source !== window || event.origin !== window.location.origin) {
      return;
    }
    var data = event.data;
    if (data && data.source === SETTINGS_SOURCE && data.settings && typeof data.settings === 'object') {
      settings.autoFetchNextLink = data.settings.autoFetchNextLink === true;
      settings.autoFetchMaxPages = GEJQ.clampInt(data.settings.autoFetchMaxPages, 1, 1000, 50);
      settings.autoFetchMaxChars = GEJQ.clampInt(data.settings.autoFetchMaxChars, 1, 50 * 1024 * 1024, 10 * 1024 * 1024);
    }
  });

  function isGraphHost(hostname) {
    var h = String(hostname || '').toLowerCase();
    return GRAPH_HOSTS.some(function (graphHost) {
      return h === graphHost || h.endsWith('.' + graphHost);
    });
  }

  /**
   * Returns { url, direct } for the Graph API URL a request targets, or
   * null if it is not a Graph request. `direct` is true when the request
   * itself goes to a Graph host; false when it goes through Graph
   * Explorer's anonymous-mode proxy (…/proxy?url=<encoded graph url>),
   * whose URL we must not rewrite.
   */
  function resolveGraphUrl(rawUrl) {
    try {
      var u = new URL(rawUrl, window.location.href);
      if (isGraphHost(u.hostname)) {
        return { url: u.href, direct: true };
      }
      var inner = u.searchParams.get('url');
      if (inner) {
        var innerUrl = new URL(inner);
        if (isGraphHost(innerUrl.hostname)) {
          return { url: innerUrl.href, direct: false };
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

  function handleBodyText(text, method, url, status, requestHeaders) {
    if (typeof text !== 'string' || text.length === 0) {
      return null;
    }
    var entry = makeEntry(method, url, status);
    if (requestHeaders && requestHeaders.length > 0) {
      entry.requestHeaders = requestHeaders;
    }
    if (text.length > MAX_BODY_CHARS) {
      entry.tooLarge = true;
      entry.size = text.length;
      post(entry);
      return null;
    }
    var trimmed = text.replace(/^\uFEFF/, '').trim();
    if (trimmed[0] !== '{' && trimmed[0] !== '[') {
      return null; // not JSON (binary, HTML error page, …)
    }
    var json;
    try {
      json = JSON.parse(trimmed);
    } catch (e) {
      return null;
    }
    entry.json = json;
    entry.size = text.length;
    post(entry);
    return entry;
  }

  // -------------------------------------------------- @odata.nextLink pages

  /**
   * When the auto-fetch setting is on and a captured GET response is
   * paged, follow the @odata.nextLink chain (replaying the original
   * request's own headers, so authentication keeps working), merge all
   * `value` arrays, and post the combined dataset as an extra entry
   * marked with the number of pages fetched. Fetching stops at the
   * configured page-count or data-size limit; if a nextLink remains at
   * that point the entry is flagged `truncated` (and keeps the leftover
   * @odata.nextLink) so the panel can warn that the dataset is
   * incomplete.
   */
  function maybeAutoFetchAllPages(firstEntry, headers, method) {
    if (!settings.autoFetchNextLink || String(method || 'GET').toUpperCase() !== 'GET') {
      return;
    }
    var firstJson = firstEntry.json;
    if (!firstJson || typeof firstJson !== 'object' || Array.isArray(firstJson) || !Array.isArray(firstJson.value)) {
      return;
    }
    if (typeof firstJson['@odata.nextLink'] !== 'string') {
      return;
    }
    var combinedValue = firstJson.value.slice();
    var pages = 1;
    var totalSize = firstEntry.size || 0;

    /** remainingNextLink is set when limits (or a fetch error) stopped
     *  the chain while more data was still available. */
    function finish(remainingNextLink) {
      if (pages < 2 && !remainingNextLink) {
        return; // chain completed on page 1 — the original entry suffices
      }
      var combined = {};
      for (var key in firstJson) {
        if (Object.prototype.hasOwnProperty.call(firstJson, key) && key !== '@odata.nextLink') {
          combined[key] = firstJson[key];
        }
      }
      if (remainingNextLink) {
        combined['@odata.nextLink'] = remainingNextLink;
      }
      combined.value = combinedValue;
      var entry = makeEntry(method, firstEntry.url, firstEntry.status);
      entry.json = combined;
      entry.size = totalSize;
      entry.pages = pages;
      entry.truncated = !!remainingNextLink;
      if (firstEntry.requestHeaders) {
        entry.requestHeaders = firstEntry.requestHeaders;
      }
      post(entry);
    }

    function step(nextUrl) {
      var parsed;
      try {
        parsed = new URL(nextUrl);
      } catch (e) {
        finish();
        return;
      }
      if (!isGraphHost(parsed.hostname)) {
        finish();
        return;
      }
      if (pages >= settings.autoFetchMaxPages || totalSize > settings.autoFetchMaxChars) {
        finish(nextUrl);
        return;
      }
      originalFetch(nextUrl, { headers: headers })
        .then(function (response) {
          if (!response.ok) {
            finish(nextUrl);
            return;
          }
          response
            .text()
            .then(function (text) {
              var pageJson;
              try {
                pageJson = JSON.parse(text);
              } catch (e) {
                finish(nextUrl);
                return;
              }
              if (!pageJson || !Array.isArray(pageJson.value)) {
                finish(nextUrl);
                return;
              }
              totalSize += text.length;
              combinedValue = combinedValue.concat(pageJson.value);
              pages += 1;
              var next = pageJson['@odata.nextLink'];
              if (typeof next !== 'string') {
                finish();
              } else if (totalSize > settings.autoFetchMaxChars) {
                // Checked after accumulating too, so the size limit is a
                // hard ceiling rather than "limit plus one page".
                finish(next);
              } else {
                step(next);
              }
            })
            .catch(function () {
              finish(nextUrl);
            });
        })
        .catch(function () {
          finish(nextUrl);
        });
    }

    step(firstJson['@odata.nextLink']);
  }

  /** Best-effort view of the headers a fetch call is about to send. */
  function requestHeaders(input, init) {
    if (init && init.headers) {
      return init.headers;
    }
    if (input instanceof Request) {
      return input.headers;
    }
    return undefined;
  }

  /**
   * The request's own headers as sanitized {name, value} pairs — never
   * including Authorization/cookies (see sanitizeRequestHeaders). Used
   * so the panel can restore a query's headers later.
   */
  function capturedRequestHeaders(input, init) {
    try {
      var source = requestHeaders(input, init);
      if (!source) {
        return [];
      }
      var pairs = [];
      new Headers(source).forEach(function (value, name) {
        pairs.push({ name: name, value: value });
      });
      return typeof GEJQ !== 'undefined' ? GEJQ.sanitizeRequestHeaders(pairs) : [];
    } catch (e) {
      return [];
    }
  }

  // ---- fetch ----
  var originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (input, init) {
      var graphUrl = null;
      var graphInfo = null;
      var method = 'GET';
      try {
        var rawUrl =
          typeof input === 'string'
            ? input
            : input && typeof input.url === 'string'
              ? input.url
              : String(input);
        graphInfo = resolveGraphUrl(rawUrl);
        if (graphInfo) {
          graphUrl = graphInfo.url;
          method =
            (init && init.method) ||
            (input && typeof input === 'object' && input.method) ||
            'GET';
        }
      } catch (e) {
        /* never break the page's fetch */
      }
      var result = originalFetch.apply(this, arguments);
      try {
        if (graphUrl) {
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
                    var sanitized = graphInfo && graphInfo.direct ? capturedRequestHeaders(input, init) : [];
                    var entry = handleBodyText(text, method, graphUrl, response.status, sanitized);
                    if (entry && entry.json && graphInfo && graphInfo.direct) {
                      maybeAutoFetchAllPages(entry, requestHeaders(input, init), method);
                    }
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
        var graphInfo = resolveGraphUrl(info.url);
        if (graphInfo) {
          var graphUrl = graphInfo.url;
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
