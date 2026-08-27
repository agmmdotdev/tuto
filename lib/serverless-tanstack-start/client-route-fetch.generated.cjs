"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var client_route_fetch_exports = {};
__export(client_route_fetch_exports, {
  createTanstackStartRouteFetch: () => createTanstackStartRouteFetch
});
module.exports = __toCommonJS(client_route_fetch_exports);
function createTanstackStartRouteFetch(nativeFetch, previewLocation, serverRouteBase) {
  const readBody = async (request) => {
    const blob = await request.blob();
    return new Uint8Array(await blob.arrayBuffer());
  };
  const methodSupportsBody = (method) => method !== "GET" && method !== "HEAD";
  return async (input, init) => {
    const isRequest = input instanceof Request;
    const url = new URL(
      isRequest ? input.url : String(input),
      previewLocation.href
    );
    if (url.origin === previewLocation.origin && !url.pathname.startsWith("/api/serverless/tanstack-start/")) {
      const inheritedBody = isRequest && init?.body === void 0 && methodSupportsBody(input.method) ? await readBody(init === void 0 ? input : input.clone()) : void 0;
      const sourceRequest = input instanceof Request && init === void 0 ? input : input instanceof Request ? new Request(input, init) : new Request(url, init);
      const body = inheritedBody ?? (methodSupportsBody(sourceRequest.method) ? await readBody(sourceRequest) : void 0);
      return nativeFetch(
        serverRouteBase + encodeURIComponent(url.pathname + url.search),
        {
          body,
          cache: sourceRequest.cache,
          credentials: "include",
          headers: sourceRequest.headers,
          integrity: sourceRequest.integrity,
          keepalive: sourceRequest.keepalive,
          method: sourceRequest.method,
          mode: sourceRequest.mode,
          redirect: sourceRequest.redirect,
          referrer: sourceRequest.referrer,
          referrerPolicy: sourceRequest.referrerPolicy,
          signal: sourceRequest.signal
        }
      );
    }
    return nativeFetch(input, init);
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createTanstackStartRouteFetch
});
