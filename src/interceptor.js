/**
 * Graph Explorer JSON Query — network interceptor.
 *
 * Runs in the page's MAIN world (document_start) so it can wrap
 * window.fetch / XMLHttpRequest before the Graph Explorer app boots.
 * Every JSON response coming back from a Microsoft Graph endpoint is
 * forwarded to the extension's content script via window.postMessage.
 *
 * When the "advanced queries" setting is on (the default), outgoing GET
 * requests that use $filter/$search/$orderby/$count are upgraded with
 * the `ConsistencyLevel: eventual` header and `$count=true`, as
 * required by Microsoft Graph advanced queries. The content script
 * pushes setting changes in via window.postMessage.
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
    advancedQuery: true,
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
      settings.advancedQuery = data.settings.advancedQuery !== false;
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

  function handleBodyText(text, method, url, status) {
    if (typeof text !== 'string' || text.length === 0) {
      return null;
    }
    var entry = makeEntry(method, url, status);
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
   * Upgrade an outgoing fetch to a Graph advanced query when the setting
   * is on: append $count=true and add `ConsistencyLevel: eventual` for
   * GET requests using $filter/$search/$orderby/$count. Only rewrites
   * direct Graph calls — the anonymous-mode proxy wraps the target URL
   * and is left untouched. Returns [input, init].
   */
  function upgradeRequest(input, init, graphInfo, method) {
    if (!settings.advancedQuery || typeof GEJQ === 'undefined' || !graphInfo.direct) {
      return [input, init];
    }
    var advanced = GEJQ.applyAdvancedQuery(graphInfo.url, method);
    if (!advanced.addHeader) {
      return [input, init];
    }
    if (typeof input === 'string' || (input instanceof URL && !(input instanceof Request))) {
      var headers = new Headers((init && init.headers) || undefined);
      if (!headers.has('ConsistencyLevel')) {
        headers.set('ConsistencyLevel', 'eventual');
      }
      var newInit = {};
      for (var key in init) {
        newInit[key] = init[key];
      }
      newInit.headers = headers;
      return [advanced.url, newInit];
    }
    if (input instanceof Request) {
      var mergedHeaders = new Headers(input.headers);
      if (init && init.headers) {
        new Headers(init.headers).forEach(function (headerValue, headerName) {
          mergedHeaders.set(headerName, headerValue);
        });
      }
      if (!mergedHeaders.has('ConsistencyLevel')) {
        mergedHeaders.set('ConsistencyLevel', 'eventual');
      }
      // GET/HEAD requests carry no body, so all other fields can be
      // copied from the original Request while swapping the URL.
      var rebuilt = new Request(advanced.url, {
        method: input.method,
        headers: mergedHeaders,
        mode: input.mode,
        credentials: input.credentials,
        cache: input.cache,
        redirect: input.redirect,
        referrer: input.referrer,
        referrerPolicy: input.referrerPolicy,
        integrity: input.integrity,
        signal: input.signal
      });
      var restInit = {};
      var changed = false;
      for (var initKey in init) {
        if (initKey !== 'headers') {
          restInit[initKey] = init[initKey];
          changed = true;
        }
      }
      return [rebuilt, changed ? restInit : undefined];
    }
    return [input, init];
  }

  // ---- fetch ----
  var originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (input, init) {
      var graphUrl = null;
      var method = 'GET';
      try {
        var rawUrl =
          typeof input === 'string'
            ? input
            : input && typeof input.url === 'string'
              ? input.url
              : String(input);
        var graphInfo = resolveGraphUrl(rawUrl);
        if (graphInfo) {
          graphUrl = graphInfo.url;
          method =
            (init && init.method) ||
            (input && typeof input === 'object' && input.method) ||
            'GET';
          var upgraded = upgradeRequest(input, init, graphInfo, method);
          input = upgraded[0];
          init = upgraded[1];
          graphUrl =
            typeof input === 'string'
              ? input
              : input && typeof input.url === 'string'
                ? input.url
                : graphUrl;
        }
      } catch (e) {
        /* never break the page's fetch */
      }
      var result = init === undefined ? originalFetch.call(this, input) : originalFetch.call(this, input, init);
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
                    var entry = handleBodyText(text, method, graphUrl, response.status);
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
