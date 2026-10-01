import { readFile } from "node:fs/promises";
import path from "node:path";
import type { NextNavigationRequest } from "./navigation";
import type { NextRequestArtifact } from "./artifact";
import { matchNextRouteHandler } from "./route-manifest";
import { nextPrefetchKey } from "./prefetch";
import {
  getNextRscWorkerPool,
  type NextFlightWorkerResult,
  type NextFlightStreamWorkerResult,
  type NextSerializedActionBody,
} from "./rsc-worker-pool";
import { getNextSsrWorkerPool } from "./ssr-worker-pool";

export type NextRuntimeRequest = {
  headers?: HeadersInit;
  url?: string;
};

export type NextRouteHandlerRequest = NextRuntimeRequest & {
  body?: string | Uint8Array;
  headers?: HeadersInit;
  method?: string;
};

export type NextExecuteRequest = NextRouteHandlerRequest & {
  actionEndpoint?: string;
  hydrate?: boolean;
  navigation?: NextNavigationRequest;
  loading?: boolean;
  stream?: boolean;
};

async function flightToHtml(
  artifact: NextRequestArtifact,
  result: NextFlightWorkerResult,
  url = "/",
) {
  const html = await getNextSsrWorkerPool().render(
    artifact,
    result.flight,
    result.formState,
    url,
  );
  const styles = styleElements(artifact, result.stylePaths);
  if (!styles) return html;
  if (html.includes("</head>")) {
    return html.replace("</head>", () => `${styles}</head>`);
  }
  return `${styles}${html}`;
}

function styleElements(artifact: NextRequestArtifact, stylePaths: string[]) {
  return stylePaths
    .map((stylePath) => {
      const style = artifact.styles[stylePath];
      if (!style) return "";
      const safePath = stylePath
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
      return `<style data-tuto-next-style="${safePath}">${style.css.replaceAll("</style", "<\\/style")}</style>`;
    })
    .join("");
}

async function readableStreamBuffer(stream: ReadableStream<Uint8Array>) {
  const chunks: Buffer[] = [];
  const reader = stream.getReader();
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    chunks.push(Buffer.from(chunk.value));
  }
  return Buffer.concat(chunks);
}

async function prefetchReadableStream(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const first = await reader.read();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (first.done) controller.close();
      else controller.enqueue(first.value);
    },
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) controller.close();
        else controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function inlineScript(code: string) {
  return code.replaceAll("</script", "<\\/script");
}

function htmlAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function wireProgressiveActionForms(
  html: string,
  config: { actionEndpoint?: string; revision: string; url: string },
) {
  if (!config.actionEndpoint) return html;
  const endpoint = htmlAttribute(config.actionEndpoint);
  const metadata = `<input type="hidden" name="$TUTO_NEXT_REVISION" value="${htmlAttribute(config.revision)}"/><input type="hidden" name="$TUTO_NEXT_URL" value="${htmlAttribute(config.url)}"/>`;
  return html.replace(
    /<form(?=[^>]*\baction="")(?=[^>]*\bmethod="POST")(?=[^>]*\benctype="multipart\/form-data")([^>]*)>/gi,
    (opening) =>
      opening.replace('action=""', `action="${endpoint}"`) + metadata,
  );
}

let clientKernelPromise: Promise<string> | undefined;

function readClientKernel() {
  clientKernelPromise ??= readFile(
    path.resolve(
      process.cwd(),
      "lib",
      "serverless-next",
      "client-kernel.generated.js",
    ),
    "utf8",
  );
  return clientKernelPromise;
}

function hydrationBootstrap(
  flight: Buffer,
  config: {
    actionEndpoint?: string;
    generation: string;
    headers: Array<[string, string]>;
    revision: string;
    url: string;
    formState?: unknown;
  },
) {
  return `(async () => {
  const encoded = ${JSON.stringify(flight.toString("base64"))};
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  const kernel = globalThis.__TUTO_NEXT_CLIENT_KERNEL__;
  const actionHeaders = new Headers(${JSON.stringify(config.headers)});
  globalThis.__TUTO_NEXT_URL__ = ${JSON.stringify(config.url)};
  const endpoint = ${JSON.stringify(config.actionEndpoint)};
  let navigationSequence = 0;
  let pendingNavigation;
  let navigationActive = false;
  const navigationCommits = new Map();
  globalThis.__TUTO_NEXT_NAVIGATION_COMMIT__ = (id) => navigationCommits.get(id)?.();
  const prefetchKey = ${nextPrefetchKey.toString()};
  const prefetchOwner = [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2,"0")).join("");
  const prefetchEntries = new Map();
  let prefetchEpoch = 0;
  let prefetchSequence = 0;
  const segmentGrants = new Map();
  globalThis.__TUTO_NEXT_SEGMENT_ACCEPT__ = key => [...segmentGrants.values()].some(grant =>
    grant.expiresAt > Date.now() && grant.keys.includes(key));
  function segmentRefs(id) {
    for (const [token, grant] of segmentGrants) if (grant.expiresAt <= Date.now()) segmentGrants.delete(token);
    kernel.router.pruneSegments([...segmentGrants.values()].flatMap(grant => grant.keys));
    const keys = kernel.router.pinSegments(id);
    const refs = [];
    for (const [token, grant] of segmentGrants) {
      const selected = grant.keys.filter(key => keys.includes(key));
      if (selected.length) refs.push({token,keys:selected});
    }
    return refs;
  }
  function invalidateSegments() {segmentGrants.clear();kernel.router.clearSegments();}
  let prefetchPending;
  let prefetchScheduler;
  let actionRequests = 0;
  function invalidatePrefetch() {
    prefetchEpoch++;
    prefetchScheduler?.pause();
    prefetchPending?.abort();
    prefetchPending = undefined;
    const entries = [...prefetchEntries.values()];
    prefetchEntries.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      kernel.router.releaseSegments(entry.requestId);
      for (const callback of entry.callbacks) { try { callback(); } catch (error) { console.error(error); } }
    }
  }
  function currentPrefetchKey(target, mode = "full") {
    return prefetchKey(${JSON.stringify(config.revision)}, target.pathname + target.search,
      Object.fromEntries(actionHeaders.entries()), globalThis.__TUTO_NEXT_ROUTER_STATE__, mode);
  }
  globalThis.__TUTO_NEXT_PREFETCH__ = async (href, options = {}) => {
    if (!endpoint || navigationActive || actionRequests || options._signal?.aborted) return;
    const target = new URL(String(href), new URL(globalThis.__TUTO_NEXT_URL__, "http://next.local"));
    if (target.origin !== "http://next.local") return;
    const mode = options._prefetchMode === "auto" ? "auto" : "full";
    const key = currentPrefetchKey(target, mode);
    const full = prefetchEntries.get(currentPrefetchKey(target, "full"));
    const automatic = prefetchEntries.get(currentPrefetchKey(target, "auto"));
    let entry = full?.ticket ? full : automatic?.kind === "full" && automatic?.ticket ? automatic : prefetchEntries.get(key);
    if (entry) {
      if (!options._signal) entry.manual = true;
      if (typeof options.onInvalidate === "function") entry.callbacks.add(options.onInvalidate);
      return entry.promise;
    }
    // Only one speculative render at a time. Explicit callers can retry later.
    if (prefetchPending) return;
    const controller = new AbortController();
    prefetchPending = controller;
    if (prefetchEntries.size >= 8) {
      const [oldKey, oldEntry] = prefetchEntries.entries().next().value;
      prefetchEntries.delete(oldKey);
      clearTimeout(oldEntry.timer);
      kernel.router.releaseSegments(oldEntry.requestId);
      for (const callback of oldEntry.callbacks) {try {callback();} catch(error) {console.error(error);}}
    }
    const epoch = prefetchEpoch;
    const requestId = "prefetch:" + ++prefetchSequence;
    const refs = segmentRefs(requestId);
    entry = {callbacks:new Set(typeof options.onInvalidate === "function" ? [options.onInvalidate] : []), controller, mode, requestId, manual:!options._signal};
    prefetchEntries.set(key, entry);
    const ownedEntry = entry;
    const cancel = () => { if (!ownedEntry.manual) controller.abort(); };
    options._signal?.addEventListener("abort", cancel, {once:true});
    entry.promise = (async () => {
      try {
        const response = await fetch(endpoint, {
          method:"POST", headers:{"content-type":"text/plain;charset=UTF-8"}, signal:controller.signal,
          body:JSON.stringify({navigation:{kind:"push", id:requestId, segmentRefs:refs,
            prefetch:true, prefetchMode:mode, prefetchOwner, revision:${JSON.stringify(config.revision)},
            url:target.pathname + target.search, state:globalThis.__TUTO_NEXT_ROUTER_STATE__,
            headers:Object.fromEntries(actionHeaders.entries())}}),
        });
        if (response.status !== 200 || epoch !== prefetchEpoch) {
          if (prefetchEntries.get(key) === entry) prefetchEntries.delete(key);
          return;
        }
        const result = await response.json();
        if (controller.signal.aborted || epoch !== prefetchEpoch || prefetchEntries.get(key) !== entry) {
          if (prefetchEntries.get(key) === entry) prefetchEntries.delete(key);
          return;
        }
        const receivedAt = Date.now(), expiresAt = receivedAt + result.ttlMs;
        let decoded;
        if (result.kind === "shell" && typeof result.shellFlight === "string" && result.shellFlight.length <= 1398104) {
          let timedOut = false, timer, abort;
          try {
            const stopped = new Promise((_, reject) => {
              abort = () => reject(new DOMException("Prefetch decoding cancelled.","AbortError"));
              controller.signal.addEventListener("abort",abort,{once:true});
              timer = setTimeout(() => {timedOut=true;reject(new Error("Prefetch decoding timed out."));},2000);
            });
            const decode = (async () => {
              const bytes = Uint8Array.from(atob(result.shellFlight),character => character.charCodeAt(0));
              const stream = new ReadableStream({start(output){output.enqueue(bytes);output.close();}});
              const shell = await kernel.rscClient.createFromReadableStream(stream,{callServer:globalThis.__TUTO_NEXT_CALL_SERVER__});
              const templates = await kernel.router.collectSegments(shell.root,result.segmentGrant?.keys ?? [],() => timedOut || controller.signal.aborted);
              return {shell,templates};
            })();
            decoded = await Promise.race([decode,stopped]);
          } catch { /* Speculative decoding is optional; normal ticket validation/rendering remains available. */ }
          finally {clearTimeout(timer);controller.signal.removeEventListener("abort",abort);}
        }
        if (controller.signal.aborted || epoch !== prefetchEpoch || prefetchEntries.get(key) !== entry || expiresAt <= Date.now()) {
          if (prefetchEntries.get(key) === entry) prefetchEntries.delete(key);
          return;
        }
        if (result.segmentGrant) {
          const grant = result.segmentGrant;
          segmentGrants.set(grant.token,{keys:grant.keys,expiresAt:Math.min(expiresAt,receivedAt+grant.ttlMs)});
          while (segmentGrants.size > 8) segmentGrants.delete(segmentGrants.keys().next().value);
          if (decoded) {kernel.router.storeSegments(decoded.templates);kernel.router.pinSegments(requestId);}
        }
        entry.shell = decoded?.shell;
        entry.epoch = epoch;
        entry.expiresAt = expiresAt;
        entry.ticket = result.ticket;
        entry.kind = result.kind || "full";
        entry.timer = setTimeout(() => {
          if (prefetchEntries.get(key) !== entry) return;
          prefetchEntries.delete(key);
          kernel.router.releaseSegments(entry.requestId);
          for (const callback of entry.callbacks) {try {callback();} catch(error) {console.error(error);}}
        }, Math.max(0,expiresAt-Date.now()));
      } catch (error) {
        if (prefetchEntries.get(key) === entry) prefetchEntries.delete(key);
        if (error.name !== "AbortError") console.error(error);
      } finally {
        if (!entry.ticket) kernel.router.releaseSegments(requestId);
        options._signal?.removeEventListener("abort", cancel);
        if (prefetchPending === controller) prefetchPending = undefined;
        prefetchScheduler?.resume();
      }
    })();
    return entry.promise;
  };
  prefetchScheduler = kernel.createPrefetchScheduler({
    key(href, mode) {
      try {
      const previous = new URL(globalThis.__TUTO_NEXT_URL__, "http://next.local");
      const target = new URL(String(href), previous);
      if (target.origin !== previous.origin || target.pathname === previous.pathname && target.search === previous.search) return;
      return currentPrefetchKey(target, mode);
      } catch { return; }
    },
    prefetch:globalThis.__TUTO_NEXT_PREFETCH__,
    busy:() => navigationActive || actionRequests > 0 || Boolean(prefetchPending),
  });
  globalThis.__TUTO_NEXT_REGISTER_LINK__ = (element, href, mode) => prefetchScheduler.observe(element, href, mode);
  window.addEventListener("pagehide", () => prefetchScheduler.dispose(), {once:true});
  const historyEntries = [];
  let historyIndex = -1;
  const historyToken = Math.random().toString(36).slice(2);
  const pathOf = (url) => url.pathname + url.search + url.hash;
  function snapshot() {
    return {
      path: globalThis.__TUTO_NEXT_URL__,
      state: globalThis.__TUTO_NEXT_ROUTER_STATE__,
      scroll: [window.scrollX, window.scrollY],
    };
  }
  function rememberInitialEntry() {
    if (historyIndex >= 0) return;
    historyEntries.push(snapshot());
    historyIndex = 0;
    try { history.scrollRestoration = "manual"; history.replaceState({ tuto: historyToken, index: 0 }, ""); } catch {}
  }
  function applyNavigationStyles(payload) {
    for (const style of payload.styles || []) {
      let element = [...document.querySelectorAll("style[data-tuto-next-style]")].find(element => element.dataset.tutoNextStyle === style.path);
      if (!element) { element = document.createElement("style"); element.dataset.tutoNextStyle = style.path; document.head.append(element); }
      element.textContent = style.css;
    }
  }
  async function commitNavigationModel(payload, controller, token, provisional = false) {
    const committed = new Promise((resolve, reject) => {
      const id = payload.state?.navigationId || String(token);
      const onAbort = () => {
        navigationCommits.delete(id);
        controller.signal.removeEventListener("abort", onAbort);
        delete controller.invalidate;
        reject(new DOMException("Navigation cancelled", "AbortError"));
      };
      controller.invalidate = onAbort;
      controller.signal.addEventListener("abort", onAbort, {once:true});
      navigationCommits.set(id, () => {
        controller.signal.removeEventListener("abort", onAbort);
        navigationCommits.delete(id);
        delete controller.invalidate;
        resolve();
      });
    });
    if (!provisional) controller.rendered = true;
    kernel.react.startTransition(() => root.render(payload.root));
    await committed;
  }
  let currentRootModel;
  async function navigate(navigation, path, options = {}, restoreIndex) {
    if (!endpoint) {
      window.parent?.postMessage({ kind: "navigate", navigation, path, source: "tuto-serverless-nextjs-runtime-preview-log" }, "*");
      return;
    }
    if (navigation === "refresh") {invalidateSegments();invalidatePrefetch();}
    rememberInitialEntry();
    if (navigation === "back" || navigation === "forward") {
      const index = historyIndex + (navigation === "back" ? -1 : 1);
      if (index < 0 || index >= historyEntries.length) return;
      // The sandboxed document owns state-only history entries; its capability URL stays private.
      history.go(index - historyIndex);
      return;
    }
    const previous = new URL(globalThis.__TUTO_NEXT_URL__, "http://next.local");
    const target = new URL(path || pathOf(previous), previous);
    if (target.origin !== "http://next.local") throw new Error("Preview navigation must stay inside the workspace.");
    const token = ++navigationSequence;
    // React may retain unresolved Flight references in active/hidden branches.
    // Cancel transport before handing it to React; afterward drain the bounded
    // render while sequence checks prevent it from taking navigation ownership.
    pendingNavigation?.invalidate?.();
    if (!pendingNavigation?.rendered) pendingNavigation?.abort();
    const controller = new AbortController();
    pendingNavigation = controller;
    navigationActive = true;
    prefetchScheduler.pause();
    prefetchPending?.abort();
    let shellDisplayed = false;
    let consumedPrefetch;
    const refs = segmentRefs(String(token));
    try {
    historyEntries[historyIndex] = snapshot();
    const restoring = navigation === "restore";
    const restored = restoring ? historyEntries[restoreIndex] : undefined;
    const hashOnly = navigation !== "refresh" && previous.pathname === target.pathname && previous.search === target.search;
    let payload;
    let status = 200;
    if (!hashOnly || navigation === "refresh" || restoring) {
      const cacheKey = prefetchEntries.get(currentPrefetchKey(target))?.ticket ? currentPrefetchKey(target) : currentPrefetchKey(target, "auto");
      const prefetched = !restoring && navigation !== "refresh" ? prefetchEntries.get(cacheKey) : undefined;
      // Never let speculative work delay an actual navigation.
      const ticket = prefetched?.ticket;
      if (prefetched) {consumedPrefetch=prefetched;prefetchEntries.delete(cacheKey); clearTimeout(prefetched.timer);}
      prefetchPending?.abort();
      const navigationRequest = {
          kind: navigation, id: String(token), sequence: token, prefetchOwner, segmentRefs:refs,
          revision: ${JSON.stringify(config.revision)}, url: pathOf(target),
          state: restored?.state || globalThis.__TUTO_NEXT_ROUTER_STATE__, headers:Object.fromEntries(actionHeaders.entries()),
      };
      const requestOptions = {
        method: "POST",
        headers: { "content-type": "text/plain;charset=UTF-8" },
        body: JSON.stringify({ navigation: {
          ...navigationRequest,
          ...(ticket ? {prefetchTicket:ticket, prefetchMode:prefetched.mode,
            ...(prefetched.kind === "shell" ? {prefetchShell:true,
              ...(prefetched.shell && prefetched.expiresAt > Date.now() ? {prefetchShellAck:true} : {})} : {})} : {}),
        } }),
        signal: controller.signal,
        redirect: "manual",
      };
      let response = await fetch(endpoint, requestOptions);
      if (token !== navigationSequence) return;
      if (ticket && response.headers.get("x-tuto-next-prefetch") === "miss") {
        const callbacks = [...prefetched.callbacks];
        prefetched.callbacks.clear();
        for (const callback of callbacks) {try {callback();} catch (error) {console.error(error);}}
      }
      if (ticket && prefetched.kind === "shell") {
        const hit = response.headers.get("x-tuto-next-prefetch");
        const current = prefetched.epoch === prefetchEpoch && prefetched.expiresAt > Date.now() &&
          cacheKey === currentPrefetchKey(target,prefetched.mode);
        const shell = current && hit === "shell-ack" && response.status === 204 ? prefetched.shell :
          current && hit === "shell-hit" && response.body ?
            await kernel.rscClient.createFromReadableStream(response.body, {callServer:globalThis.__TUTO_NEXT_CALL_SERVER__}) : undefined;
        if (shell) {
          if (token !== navigationSequence) return;
          applyNavigationStyles(shell);
          shellDisplayed = true;
          await commitNavigationModel(shell, controller, token, true);
          if (token !== navigationSequence) return;
        }
        // Shell validation never owns URL/history/cookies. The fresh request
        // uses the original slot state and retains normal streamed control flow.
        navigationRequest.segmentRefs = segmentRefs(String(token));
        navigationRequest.headers = Object.fromEntries(actionHeaders.entries());
        response = await fetch(endpoint, {...requestOptions, body:JSON.stringify({navigation:navigationRequest})});
        if (token !== navigationSequence) return;
      }
      applyVirtualCookies(response);
      const location = response.headers.get("location");
      if (location) return navigate("replace", location, options);
      if (!(response.headers.get("content-type") || "").startsWith("text/x-component") || !response.body) {
        throw new Error((await response.text()) || "The navigation returned a non-Flight response.");
      }
      status = response.status;
      payload = await kernel.rscClient.createFromReadableStream(response.body, { callServer: globalThis.__TUTO_NEXT_CALL_SERVER__ });
      if (token !== navigationSequence) return;
      applyNavigationStyles(payload);
    }
    if (payload) {
      await commitNavigationModel(payload, controller, token);
      if (token !== navigationSequence) return;
      currentRootModel = payload.root;
    }
    kernel.router.setUrl(pathOf(target));
    invalidatePrefetch();
    if (restoring) historyIndex = restoreIndex;
    else if (navigation === "push") {
      historyEntries.splice(historyIndex + 1);
      historyEntries.push(snapshot());
      historyIndex++;
      history.pushState({ tuto: historyToken, index: historyIndex }, "");
    } else historyEntries[historyIndex] = snapshot();
    if (navigation === "replace") history.replaceState({ tuto: historyToken, index: historyIndex }, "");
    if (restoring) window.scrollTo(...(restored?.scroll || [0, 0]));
    else if (navigation !== "refresh" && options.scroll !== false) {
      const anchor = target.hash && document.getElementById(decodeURIComponent(target.hash.slice(1)));
      if (anchor) anchor.scrollIntoView();
      else window.scrollTo(0, 0);
    }
    window.parent?.postMessage({
      kind: "navigation-state", navigation, path: pathOf(target), status,
      source: "tuto-serverless-nextjs-runtime-preview-log",
    }, "*");
    } catch (error) {
      if (shellDisplayed && token === navigationSequence && !controller.rendered) {
        kernel.react.startTransition(() => root.render(currentRootModel));
      }
      throw error;
    } finally {
      kernel.router.releaseSegments(String(token));
      if (consumedPrefetch) kernel.router.releaseSegments(consumedPrefetch.requestId);
      if (token === navigationSequence) { navigationActive = false; prefetchScheduler.resume(); }
    }
  }
  globalThis.__TUTO_NEXT_NAVIGATE__ = (navigation, path, options) => {
    navigate(navigation, path, options).catch((error) => {
      if (error.name !== "AbortError") console.error(error);
    });
  };
  window.addEventListener("popstate", (event) => {
    if (event.state?.tuto !== historyToken) return;
    const index = event.state.index;
    if (!historyEntries[index]) return;
    navigate("restore", historyEntries[index].path, {}, index).catch((error) => {
      if (error.name !== "AbortError") console.error(error);
    });
  });
  function handleAnchorClick(event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!anchor || anchor.hasAttribute("download") || (anchor.target && anchor.target !== "_self")) return;
    const target = new URL(anchor.getAttribute("href"), new URL(globalThis.__TUTO_NEXT_URL__, "http://next.local"));
    if (target.origin !== "http://next.local") return;
    event.preventDefault();
    globalThis.__TUTO_NEXT_NAVIGATE__("push", target.pathname + target.search + target.hash);
  }
  let root;
  function bytesToBase64(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }
  async function serializeBody(body) {
    if (typeof body === "string") return { kind: "string", value: body };
    const entries = [];
    for (const [name, value] of body.entries()) {
      if (typeof value === "string") entries.push({ kind: "string", name, value });
      else entries.push({
        contentType: value.type || "application/octet-stream",
        filename: value.name || "blob",
        kind: "file",
        name,
        value: bytesToBase64(new Uint8Array(await value.arrayBuffer())),
      });
    }
    return { entries, kind: "form-data" };
  }
  function applyVirtualCookies(response) {
    const encoded = response.headers.get("x-tuto-next-virtual-set-cookie");
    if (!encoded) return;
    invalidateSegments();
    invalidatePrefetch();
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    const setCookies = JSON.parse(new TextDecoder().decode(bytes));
    const jar = new Map();
    for (const part of (actionHeaders.get("cookie") || "").split(";")) {
      const pair = part.trim();
      const equals = pair.indexOf("=");
      if (equals > 0) jar.set(pair.slice(0, equals), pair.slice(equals + 1));
    }
    for (const setCookie of setCookies) {
      const pair = setCookie.split(";", 1)[0];
      const equals = pair.indexOf("=");
      if (equals <= 0) continue;
      const name = pair.slice(0, equals).trim();
      const value = pair.slice(equals + 1);
      const maxAge = /(?:^|;)\\s*max-age\\s*=\\s*(-?\\d+)/i.exec(setCookie);
      const expires = /(?:^|;)\\s*expires\\s*=\\s*([^;]+)/i.exec(setCookie);
      const expired = maxAge
        ? Number(maxAge[1]) <= 0
        : expires
          ? Date.parse(expires[1]) <= Date.now()
          : false;
      if (expired) jar.delete(name);
      else jar.set(name, value);
    }
    if (jar.size > 0) {
      actionHeaders.set("cookie", [...jar].map(([name, value]) => name + "=" + value).join("; "));
    } else {
      actionHeaders.delete("cookie");
    }
  }
  globalThis.__TUTO_NEXT_CALL_SERVER__ = async (actionId, args) => {
    const endpoint = ${JSON.stringify(config.actionEndpoint)};
    if (!endpoint) throw new Error("This preview has no Server Action endpoint.");
    actionRequests++;
    try {
    invalidateSegments();
    invalidatePrefetch();
    const body = await kernel.rscClient.encodeReply(args);
    const response = await fetch(endpoint, {
      body: JSON.stringify({
        action: { actionId, body: await serializeBody(body), headers: Object.fromEntries(actionHeaders.entries()), revision: ${JSON.stringify(config.revision)}, url: globalThis.__TUTO_NEXT_URL__ },
      }),
      headers: { "content-type": "text/plain;charset=UTF-8" },
      method: "POST",
      redirect: "manual",
    });
    invalidatePrefetch();
    applyVirtualCookies(response);
    const location = response.headers.get("location");
    if (location) {
      const redirect = response.headers.get("x-action-redirect") || "";
      globalThis.__TUTO_NEXT_NAVIGATE__(
        redirect.endsWith(";replace") ? "replace" : "push",
        location,
      );
      return undefined;
    }
    if (!response.ok || !response.body) {
      throw new Error(
        (await response.text()) || "The Server Action request failed.",
      );
    }
    if (!(response.headers.get("content-type") || "").startsWith("text/x-component")) {
      throw new Error(
        (await response.text()) ||
          "The Server Action proxy returned a non-Flight response.",
      );
    }
    const payload = await kernel.rscClient.createFromReadableStream(response.body, {
      callServer: globalThis.__TUTO_NEXT_CALL_SERVER__,
    });
    // A form action transition must finish before its refresh can commit.
    // Waiting for that commit here would make useActionState wait on itself.
    globalThis.__TUTO_NEXT_NAVIGATE__("refresh", globalThis.__TUTO_NEXT_URL__, { scroll: false });
    return payload.actionResult;
    } finally { actionRequests--; prefetchScheduler.resume(); }
  };
  const model = await kernel.rscClient.createFromReadableStream(stream, {
    callServer: globalThis.__TUTO_NEXT_CALL_SERVER__,
  });
  const formState = ${JSON.stringify(config.formState)};
  currentRootModel = model;
  root = kernel.reactDomClient.hydrateRoot(
    document,
    model,
    formState === undefined ? undefined : { formState },
  );
  // React's delegated handlers must run first so Link/user preventDefault,
  // replace and scroll options are not preempted by the plain-anchor fallback.
  document.addEventListener("click", handleAnchorClick);
  globalThis.__TUTO_NEXT_ROOT__ = root;
  globalThis.__TUTO_NEXT_HYDRATED__ = ${JSON.stringify(config.generation)};
})().catch((error) => {
  globalThis.__TUTO_NEXT_HYDRATION_ERROR__ = error instanceof Error ? error.stack : String(error);
  console.error(error);
});`;
}

async function hydratableDocument(
  artifact: NextRequestArtifact,
  result: NextFlightWorkerResult,
  config: {
    actionEndpoint?: string;
    headers: Array<[string, string]>;
    url: string;
  },
) {
  const html = wireProgressiveActionForms(
    await flightToHtml(artifact, result, config.url),
    {
      actionEndpoint: config.actionEndpoint,
      revision: artifact.revision,
      url: config.url,
    },
  );
  const scripts = `<script>${inlineScript(await readClientKernel())}</script>
<script>${inlineScript(artifact.clientBundle.code)}</script>
<script type="module">${inlineScript(
    hydrationBootstrap(result.flight, {
      actionEndpoint: config.actionEndpoint,
      formState: result.formState,
      generation: artifact.generation,
      headers: config.headers,
      revision: artifact.revision,
      url: config.url,
    }),
  )}</script>`;
  // Callback replacements preserve literal $&/$` sequences in generated JavaScript.
  return html.includes("</body>")
    ? html.replace("</body>", () => `${scripts}</body>`)
    : `${html}${scripts}`;
}

function transformHydratableHtmlStream(
  html: ReadableStream<Uint8Array>,
  options: {
    actionEndpoint?: string;
    scripts: Promise<string>;
    styles: string;
    revision: string;
    url: string;
  },
) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = "";
  let injectedStyles = false;

  const processHtml = (value: string) => {
    let next = wireProgressiveActionForms(value, {
      actionEndpoint: options.actionEndpoint,
      revision: options.revision,
      url: options.url,
    });
    if (!injectedStyles && next.includes("</head>")) {
      next = next.replace("</head>", () => `${options.styles}</head>`);
      injectedStyles = true;
    }
    return next;
  };

  return html.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffered += decoder.decode(chunk, { stream: true });
        const bodyClose = buffered.indexOf("</body>");
        const lastOpeningBracket = buffered.lastIndexOf("<");
        const lastClosingBracket = buffered.lastIndexOf(">");
        const emitLength =
          bodyClose >= 0
            ? bodyClose
            : lastOpeningBracket > lastClosingBracket
              ? lastOpeningBracket
              : buffered.length;
        if (emitLength <= 0) return;
        const value = processHtml(buffered.slice(0, emitLength));
        buffered = buffered.slice(emitLength);
        controller.enqueue(encoder.encode(value));
      },
      async flush(controller) {
        buffered += decoder.decode();
        let value = processHtml(buffered);
        if (!injectedStyles && options.styles) {
          value = `${options.styles}${value}`;
        }
        const scripts = await options.scripts;
        value = value.includes("</body>")
          ? value.replace("</body>", () => `${scripts}</body>`)
          : `${value}${scripts}`;
        controller.enqueue(encoder.encode(value));
      },
    }),
  );
}

async function hydratableDocumentStream(
  artifact: NextRequestArtifact,
  result: NextFlightStreamWorkerResult,
  config: {
    actionEndpoint?: string;
    headers: Array<[string, string]>;
    url: string;
  },
) {
  const [ssrFlight, hydrationFlight] = result.flight.tee();
  const flight = readableStreamBuffer(hydrationFlight);
  const rendered = await getNextSsrWorkerPool().renderStream(
    artifact,
    ssrFlight,
    result.formState,
    config.url,
  );
  const scripts = Promise.all([flight, readClientKernel()]).then(
    ([flightBody, clientKernel]) =>
      `<script>${inlineScript(clientKernel)}</script>\n<script>${inlineScript(artifact.clientBundle.code)}</script>\n<script type="module">${inlineScript(
        hydrationBootstrap(flightBody, {
          actionEndpoint: config.actionEndpoint,
          formState: result.formState,
          generation: artifact.generation,
          headers: config.headers,
          revision: artifact.revision,
          url: config.url,
        }),
      )}</script>`,
  );
  const stream = transformHydratableHtmlStream(rendered.stream, {
    actionEndpoint: config.actionEndpoint,
    revision: artifact.revision,
    scripts,
    styles: styleElements(artifact, result.stylePaths),
    url: config.url,
  });
  const final = Promise.all([result.final, rendered.final]);
  void final.catch(() => undefined);
  return {
    final,
    stream: await prefetchReadableStream(stream),
  };
}

function responseHeaders(
  artifact: NextRequestArtifact,
  result: Omit<NextFlightWorkerResult, "flight">,
  contentType: string,
) {
  return {
    "cache-control": "private, no-store",
    "content-type": contentType,
    "x-tuto-next-cache": `hit=${result.cacheMetrics.hits}; stale=${result.cacheMetrics.staleHits}; miss=${result.cacheMetrics.misses}; write=${result.cacheMetrics.writes}; revalidate=${result.cacheMetrics.revalidations}`,
    "x-tuto-next-generation": artifact.generation,
    ...(result.routePattern
      ? { "x-tuto-next-route-pattern": result.routePattern }
      : {}),
  };
}

function flightResultHeaders(
  artifact: NextRequestArtifact,
  result: Omit<NextFlightWorkerResult, "flight">,
  contentType: string,
) {
  const headers = new Headers(responseHeaders(artifact, result, contentType));
  for (const [name, value] of result.headers) {
    if (name === "set-cookie") headers.append(name, value);
    else headers.set(name, value);
  }
  return headers;
}

export async function renderHydratableNextRequestArtifact(
  artifact: NextRequestArtifact,
  options: NextRuntimeRequest & { actionEndpoint?: string } = {},
) {
  const url = options.url ?? "/";
  const result = await getNextRscWorkerPool().render(artifact, url, [
    ...new Headers(options.headers).entries(),
  ]);
  if (!result.contentType.startsWith("text/x-component")) {
    return new Response(
      result.flight.length > 0 ? Uint8Array.from(result.flight) : null,
      {
        headers: flightResultHeaders(artifact, result, result.contentType),
        status: result.status,
      },
    );
  }
  const document = await hydratableDocument(artifact, result, {
    actionEndpoint: options.actionEndpoint,
    headers: [...new Headers(options.headers).entries()],
    url,
  });
  return new Response(document, {
    headers: flightResultHeaders(artifact, result, "text/html; charset=utf-8"),
    status: result.status,
  });
}

export async function renderHydratableNextRequestArtifactStream(
  artifact: NextRequestArtifact,
  options: NextRuntimeRequest & { actionEndpoint?: string } = {},
) {
  const url = options.url ?? "/";
  const requestHeaders = [...new Headers(options.headers).entries()];
  const result = await getNextRscWorkerPool().renderStream(
    artifact,
    url,
    requestHeaders,
  );
  if (!result.contentType.startsWith("text/x-component")) {
    return new Response(result.flight, {
      headers: flightResultHeaders(artifact, result, result.contentType),
      status: result.status,
    });
  }
  let document;
  try {
    document = await hydratableDocumentStream(artifact, result, {
      actionEndpoint: options.actionEndpoint,
      headers: requestHeaders,
      url,
    });
  } catch {
    await result.final.catch(() => undefined);
    return renderHydratableNextRequestArtifact(artifact, options);
  }
  return new Response(document.stream, {
    headers: flightResultHeaders(artifact, result, "text/html; charset=utf-8"),
    status: result.status,
  });
}

export async function renderHydratableNextLoadingArtifact(
  artifact: NextRequestArtifact,
  options: NextRuntimeRequest & { actionEndpoint?: string } = {},
) {
  const url = options.url ?? "/";
  const requestHeaders = [...new Headers(options.headers).entries()];
  const result = await getNextRscWorkerPool().renderLoading(
    artifact,
    url,
    requestHeaders,
  );
  if (!result.contentType.startsWith("text/x-component")) {
    return new Response(null, {
      headers: flightResultHeaders(artifact, result, result.contentType),
      status: result.status,
    });
  }
  return new Response(
    await hydratableDocument(artifact, result, {
      actionEndpoint: options.actionEndpoint,
      headers: requestHeaders,
      url,
    }),
    {
      headers: flightResultHeaders(
        artifact,
        result,
        "text/html; charset=utf-8",
      ),
      status: result.status,
    },
  );
}

export async function renderNextRequestArtifact(
  artifact: NextRequestArtifact,
  options: NextRuntimeRequest & { flight?: boolean } = {},
) {
  const result = await getNextRscWorkerPool().render(
    artifact,
    options.url ?? "/",
    [...new Headers(options.headers).entries()],
  );
  if (!result.contentType.startsWith("text/x-component")) {
    return new Response(
      result.flight.length > 0 ? Uint8Array.from(result.flight) : null,
      {
        headers: flightResultHeaders(artifact, result, result.contentType),
        status: result.status,
      },
    );
  }
  if (options.flight) {
    return new Response(Uint8Array.from(result.flight), {
      headers: flightResultHeaders(
        artifact,
        result,
        "text/x-component; charset=utf-8",
      ),
      status: result.status,
    });
  }
  const html = await flightToHtml(artifact, result, options.url ?? "/");
  return new Response(html, {
    headers: flightResultHeaders(artifact, result, "text/html; charset=utf-8"),
    status: result.status,
  });
}

export async function renderNextRequestArtifactStream(
  artifact: NextRequestArtifact,
  options: NextRuntimeRequest & { flight?: boolean } = {},
) {
  const result = await getNextRscWorkerPool().renderStream(
    artifact,
    options.url ?? "/",
    [...new Headers(options.headers).entries()],
  );
  if (!result.contentType.startsWith("text/x-component") || options.flight) {
    return new Response(result.flight, {
      headers: flightResultHeaders(artifact, result, result.contentType),
      status: result.status,
    });
  }
  let rendered;
  try {
    rendered = await getNextSsrWorkerPool().renderStream(
      artifact,
      result.flight,
      result.formState,
      options.url ?? "/",
    );
    rendered = {
      ...rendered,
      stream: await prefetchReadableStream(rendered.stream),
    };
  } catch {
    await Promise.allSettled([
      result.final,
      ...(rendered ? [rendered.final] : []),
    ]);
    return renderNextRequestArtifact(artifact, options);
  }
  return new Response(rendered.stream, {
    headers: flightResultHeaders(artifact, result, "text/html; charset=utf-8"),
    status: result.status,
  });
}

export async function serializeNextActionBody(
  body: string | FormData,
): Promise<NextSerializedActionBody> {
  if (typeof body === "string") return { kind: "string", value: body };
  const entries: Extract<
    NextSerializedActionBody,
    { kind: "form-data" }
  >["entries"] = [];
  for (const [name, value] of body.entries()) {
    if (typeof value === "string") {
      entries.push({ kind: "string", name, value });
    } else {
      entries.push({
        contentType: value.type || "application/octet-stream",
        filename: value.name || "blob",
        kind: "file",
        name,
        value: Buffer.from(await value.arrayBuffer()).toString("base64"),
      });
    }
  }
  return { entries, kind: "form-data" };
}

export async function invokeNextServerAction(
  artifact: NextRequestArtifact,
  input: {
    actionId: string;
    body: NextSerializedActionBody;
    headers?: HeadersInit;
    url?: string;
  },
) {
  const result = await getNextRscWorkerPool().invokeAction(artifact, {
    actionId: input.actionId,
    body: input.body,
    headers: [...new Headers(input.headers).entries()],
    url: input.url ?? "/",
  });
  const headers = new Headers(
    responseHeaders(artifact, result, result.contentType),
  );
  for (const [name, value] of result.headers) {
    if (name === "set-cookie") headers.append(name, value);
    else headers.set(name, value);
  }
  headers.set("access-control-allow-origin", "*");
  return new Response(Uint8Array.from(result.flight), {
    headers,
    status: result.status,
  });
}

async function serializedActionProxyBody(body: NextSerializedActionBody) {
  if (body.kind === "string") {
    return {
      body: Buffer.from(body.value),
      contentType: "text/plain;charset=UTF-8",
    };
  }
  const formData = new FormData();
  for (const entry of body.entries) {
    if (entry.kind === "string") {
      formData.append(entry.name, entry.value);
    } else {
      formData.append(
        entry.name,
        new File([Buffer.from(entry.value, "base64")], entry.filename, {
          type: entry.contentType,
        }),
      );
    }
  }
  const request = new Request("http://next.local", {
    body: formData,
    method: "POST",
  });
  return {
    body: Buffer.from(await request.arrayBuffer()),
    contentType: request.headers.get("content-type") ?? "multipart/form-data",
  };
}

export async function executeNextServerActionArtifact(
  artifact: NextRequestArtifact,
  input: {
    actionId: string;
    body: NextSerializedActionBody;
    headers?: HeadersInit;
    url?: string;
  },
) {
  const originalUrl = input.url ?? "/";
  const actionBody = await serializedActionProxyBody(input.body);
  const originalHeaders = new Headers(input.headers);
  originalHeaders.delete("content-length");
  originalHeaders.delete("host");
  originalHeaders.delete("transfer-encoding");
  originalHeaders.set("accept", "text/x-component");
  originalHeaders.set("content-type", actionBody.contentType);
  originalHeaders.set("next-action", input.actionId);
  const proxy = artifact.router.proxy
    ? await invokeNextProxy(artifact, {
        body: actionBody.body,
        headers: originalHeaders,
        method: "POST",
        url: originalUrl,
      })
    : null;
  if (proxy?.outcome === "redirect" || proxy?.outcome === "response") {
    const headers = new Headers(proxy.headers);
    headers.set("x-tuto-next-proxy", `matched=1; outcome=${proxy.outcome}`);
    headers.set("x-tuto-next-runtime-kind", "proxy");
    return new Response(
      proxy.body.length > 0 ? Uint8Array.from(proxy.body) : null,
      {
        headers,
        status: proxy.status,
        statusText: proxy.statusText,
      },
    );
  }

  const actionHeaders = new Headers(proxy?.requestHeaders ?? originalHeaders);
  const actionId = actionHeaders.get("next-action");
  if (!actionId) {
    const headers = new Headers({
      "cache-control": "private, no-store",
      "content-type": "text/plain; charset=utf-8",
      "x-tuto-next-proxy": proxy
        ? `matched=${proxy.matched ? 1 : 0}; outcome=${proxy.outcome}`
        : "absent",
      "x-tuto-next-runtime-kind": "server-action",
    });
    return new Response(
      "The proxy removed the next-action header, so the Server Action was not dispatched.",
      { headers, status: 400 },
    );
  }
  const response = await invokeNextServerAction(artifact, {
    actionId,
    body: input.body,
    headers: actionHeaders,
    url: proxy?.url ?? originalUrl,
  });
  response.headers.set("x-tuto-next-runtime-kind", "server-action");
  if (!proxy) {
    response.headers.set("x-tuto-next-proxy", "absent");
    return response;
  }
  const combinedHeaders = mergeProxyResponseHeaders(proxy.headers, response);
  combinedHeaders.set(
    "x-tuto-next-proxy",
    `matched=${proxy.matched ? 1 : 0}; outcome=${proxy.outcome}`,
  );
  return new Response(response.body, {
    headers: combinedHeaders,
    status: response.status,
    statusText: response.statusText,
  });
}

export async function executeNextProgressiveActionArtifact(
  artifact: NextRequestArtifact,
  input: {
    actionEndpoint?: string;
    body: NextSerializedActionBody;
    headers?: HeadersInit;
    url?: string;
  },
) {
  const originalUrl = input.url ?? "/";
  const encodedBody = await serializedActionProxyBody(input.body);
  const originalHeaders = new Headers(input.headers);
  originalHeaders.delete("content-length");
  originalHeaders.delete("host");
  originalHeaders.delete("transfer-encoding");
  originalHeaders.set("content-type", encodedBody.contentType);
  const proxy = artifact.router.proxy
    ? await invokeNextProxy(artifact, {
        body: encodedBody.body,
        headers: originalHeaders,
        method: "POST",
        url: originalUrl,
      })
    : null;
  if (proxy?.outcome === "redirect" || proxy?.outcome === "response") {
    const headers = new Headers(proxy.headers);
    headers.set("x-tuto-next-proxy", `matched=1; outcome=${proxy.outcome}`);
    headers.set("x-tuto-next-runtime-kind", "progressive-action");
    return new Response(
      proxy.body.length > 0 ? Uint8Array.from(proxy.body) : null,
      {
        headers,
        status: proxy.status,
        statusText: proxy.statusText,
      },
    );
  }

  const actionHeaders = new Headers(proxy?.requestHeaders ?? originalHeaders);
  const url = proxy?.url ?? originalUrl;
  const result = await getNextRscWorkerPool().invokeProgressiveAction(
    artifact,
    {
      body: input.body,
      headers: [...actionHeaders.entries()],
      url,
    },
  );
  const isFlight = result.contentType.startsWith("text/x-component");
  const body = isFlight
    ? await hydratableDocument(artifact, result, {
        actionEndpoint: input.actionEndpoint,
        headers: [...actionHeaders.entries()],
        url,
      })
    : Uint8Array.from(result.flight);
  const headers = new Headers(
    responseHeaders(
      artifact,
      result,
      isFlight ? "text/html; charset=utf-8" : result.contentType,
    ),
  );
  for (const [name, value] of result.headers) {
    if (name === "set-cookie") headers.append(name, value);
    else headers.set(name, value);
  }
  headers.set("x-tuto-next-runtime-kind", "progressive-action");
  headers.set(
    "x-tuto-next-proxy",
    proxy
      ? `matched=${proxy.matched ? 1 : 0}; outcome=${proxy.outcome}`
      : "absent",
  );
  const response = new Response(body, { headers, status: result.status });
  if (!proxy) return response;
  return new Response(response.body, {
    headers: mergeProxyResponseHeaders(proxy.headers, response),
    status: response.status,
    statusText: response.statusText,
  });
}

export async function invokeNextRouteHandler(
  artifact: NextRequestArtifact,
  options: NextRouteHandlerRequest = {},
) {
  const headers = new Headers(options.headers);
  const body =
    typeof options.body === "string"
      ? Buffer.from(options.body)
      : options.body
        ? Buffer.from(options.body)
        : undefined;
  const result = await getNextRscWorkerPool().invokeRouteHandler(artifact, {
    ...(body ? { bodyBase64: body.toString("base64") } : {}),
    headers: [...headers.entries()],
    method: (options.method ?? "GET").toUpperCase(),
    url: options.url ?? "/",
  });
  const responseHeaders = new Headers(result.headers);
  responseHeaders.set(
    "x-tuto-next-cache",
    `hit=${result.cacheMetrics.hits}; stale=${result.cacheMetrics.staleHits}; miss=${result.cacheMetrics.misses}; write=${result.cacheMetrics.writes}; revalidate=${result.cacheMetrics.revalidations}`,
  );
  responseHeaders.set("x-tuto-next-generation", artifact.generation);
  if (result.routePattern) {
    responseHeaders.set("x-tuto-next-route-pattern", result.routePattern);
  }
  return new Response(
    result.body.length > 0 ? Uint8Array.from(result.body) : null,
    {
      headers: responseHeaders,
      status: result.status,
      statusText: result.statusText,
    },
  );
}

export async function invokeNextRouteHandlerStream(
  artifact: NextRequestArtifact,
  options: NextRouteHandlerRequest = {},
) {
  const headers = new Headers(options.headers);
  const body =
    typeof options.body === "string"
      ? Buffer.from(options.body)
      : options.body
        ? Buffer.from(options.body)
        : undefined;
  const result = await getNextRscWorkerPool().invokeRouteHandlerStream(
    artifact,
    {
      ...(body ? { bodyBase64: body.toString("base64") } : {}),
      headers: [...headers.entries()],
      method: (options.method ?? "GET").toUpperCase(),
      url: options.url ?? "/",
    },
  );
  const responseHeaders = new Headers(result.headers);
  responseHeaders.set(
    "x-tuto-next-cache",
    `hit=${result.cacheMetrics.hits}; stale=${result.cacheMetrics.staleHits}; miss=${result.cacheMetrics.misses}; write=${result.cacheMetrics.writes}; revalidate=${result.cacheMetrics.revalidations}`,
  );
  responseHeaders.set("x-tuto-next-generation", artifact.generation);
  if (result.routePattern) {
    responseHeaders.set("x-tuto-next-route-pattern", result.routePattern);
  }
  return new Response(result.body, {
    headers: responseHeaders,
    status: result.status,
    statusText: result.statusText,
  });
}

function requestBody(options: NextRouteHandlerRequest) {
  if (typeof options.body === "string") return Buffer.from(options.body);
  if (options.body) return Buffer.from(options.body);
  return undefined;
}

function staticAssetPath(pathname: string) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function etagMatches(value: string | null, etag: string) {
  if (!value) return false;
  return value.split(",").some((candidate) => {
    const normalized = candidate.trim().replace(/^W\//, "");
    return normalized === "*" || normalized === etag;
  });
}

function serveNextStaticAsset(
  artifact: NextRequestArtifact,
  requestUrl: URL,
  method: string,
  requestHeaders: HeadersInit,
) {
  const asset = artifact.staticAssets[staticAssetPath(requestUrl.pathname)];
  if (!asset || (method !== "GET" && method !== "HEAD")) return null;
  const body = Buffer.from(asset.bodyBase64, "base64");
  const headers = new Headers({
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=0, must-revalidate",
    "content-length": String(body.byteLength),
    "content-type": asset.contentType,
    etag: asset.etag,
    "x-tuto-next-generation": artifact.generation,
    "x-tuto-next-runtime-kind": "public-asset",
  });
  if (
    etagMatches(new Headers(requestHeaders).get("if-none-match"), asset.etag)
  ) {
    headers.delete("content-length");
    return new Response(null, { headers, status: 304 });
  }
  return new Response(method === "HEAD" ? null : body, {
    headers,
    status: 200,
  });
}

export async function invokeNextProxy(
  artifact: NextRequestArtifact,
  options: NextRouteHandlerRequest = {},
) {
  const body = requestBody(options);
  return getNextRscWorkerPool().invokeProxy(artifact, {
    ...(body ? { bodyBase64: body.toString("base64") } : {}),
    headers: [...new Headers(options.headers).entries()],
    method: (options.method ?? "GET").toUpperCase(),
    url: options.url ?? "/",
  });
}

function mergeProxyResponseHeaders(
  proxyHeaders: Array<[string, string]>,
  response: Response,
) {
  const headers = new Headers(proxyHeaders);
  for (const [name, value] of response.headers.entries()) {
    if (name !== "set-cookie") headers.set(name, value);
  }
  if (typeof response.headers.getSetCookie === "function") {
    for (const cookie of response.headers.getSetCookie()) {
      headers.append("set-cookie", cookie);
    }
  } else {
    const cookie = response.headers.get("set-cookie");
    if (cookie) headers.append("set-cookie", cookie);
  }
  return headers;
}

export async function executeNextRequestArtifact(
  artifact: NextRequestArtifact,
  options: NextExecuteRequest = {},
) {
  const method = (options.method ?? "GET").toUpperCase();
  const originalUrl = options.url ?? "/";
  const proxy = artifact.router.proxy
    ? await invokeNextProxy(artifact, { ...options, method, url: originalUrl })
    : null;
  if (proxy?.outcome === "redirect" || proxy?.outcome === "response") {
    const headers = new Headers(proxy.headers);
    headers.set("x-tuto-next-proxy", `matched=1; outcome=${proxy.outcome}`);
    headers.set("x-tuto-next-runtime-kind", "proxy");
    return new Response(
      proxy.body.length > 0 ? Uint8Array.from(proxy.body) : null,
      {
        headers,
        status: proxy.status,
        statusText: proxy.statusText,
      },
    );
  }

  const url = proxy?.url ?? originalUrl;
  const headers = proxy?.requestHeaders ?? [
    ...new Headers(options.headers).entries(),
  ];
  const parsedUrl = new URL(url, "http://next.local");
  const matchedHandler = matchNextRouteHandler(artifact.router, parsedUrl);
  let response = serveNextStaticAsset(artifact, parsedUrl, method, headers);
  if (response) {
    // Public files are immutable bytes inside this compiled generation. The
    // URL remains revalidated because a later generation may change the file.
  } else if (matchedHandler) {
    response = await (options.stream
      ? invokeNextRouteHandlerStream(artifact, {
          body: options.body,
          headers,
          method,
          url,
        })
      : invokeNextRouteHandler(artifact, {
          body: options.body,
          headers,
          method,
          url,
        }));
    response.headers.set("x-tuto-next-runtime-kind", "route-handler");
  } else if (method === "GET" || method === "HEAD") {
    response = options.navigation
      ? await (async () => {
          const result = options.stream
            ? await getNextRscWorkerPool().renderStream(artifact, url, headers, options.navigation!)
            : await getNextRscWorkerPool().navigate(artifact, url, headers, options.navigation!);
          const body = result.flight instanceof ReadableStream ? result.flight : result.flight.length ? Uint8Array.from(result.flight) : null;
          return new Response(body, {
            headers: flightResultHeaders(artifact, result, result.contentType), status: result.status,
          });
        })()
      : options.loading
      ? await renderHydratableNextLoadingArtifact(artifact, {
          actionEndpoint: options.actionEndpoint,
          headers,
          url,
        })
      : options.hydrate && options.stream
        ? await renderHydratableNextRequestArtifactStream(artifact, {
            actionEndpoint: options.actionEndpoint,
            headers,
            url,
          })
      : options.hydrate
        ? await renderHydratableNextRequestArtifact(artifact, {
            actionEndpoint: options.actionEndpoint,
            headers,
            url,
          })
        : options.stream
          ? await renderNextRequestArtifactStream(artifact, { headers, url })
          : await renderNextRequestArtifact(artifact, { headers, url });
    response.headers.set(
      "x-tuto-next-runtime-kind",
      options.loading ? "page-loading" : "page",
    );
    if (method === "HEAD") {
      response = new Response(null, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      });
    }
  } else {
    response = new Response(null, {
      headers: { allow: "GET, HEAD" },
      status: 405,
    });
  }

  if (!proxy) {
    response.headers.set("x-tuto-next-proxy", "absent");
    return response;
  }
  const combinedHeaders = mergeProxyResponseHeaders(proxy.headers, response);
  combinedHeaders.set(
    "x-tuto-next-proxy",
    `matched=${proxy.matched ? 1 : 0}; outcome=${proxy.outcome}`,
  );
  return new Response(response.body, {
    headers: combinedHeaders,
    status: response.status,
    statusText: response.statusText,
  });
}
