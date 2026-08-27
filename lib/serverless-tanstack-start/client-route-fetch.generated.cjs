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
  return (input, init) => {
    const isRequest = input instanceof Request;
    const url = new URL(
      isRequest ? input.url : String(input),
      previewLocation.href
    );
    if (url.origin === previewLocation.origin && !url.pathname.startsWith("/api/serverless/tanstack-start/")) {
      const sourceRequest = isRequest ? new Request(input, init) : new Request(url, init);
      const gatewayRequest = new Request(
        serverRouteBase + encodeURIComponent(url.pathname + url.search),
        sourceRequest
      );
      return nativeFetch(
        new Request(gatewayRequest, { credentials: "include" })
      );
    }
    return nativeFetch(input, init);
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createTanstackStartRouteFetch
});
