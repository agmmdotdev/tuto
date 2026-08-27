type PreviewLocation = {
  href: string;
  origin: string;
};

export function createTanstackStartRouteFetch(
  nativeFetch: typeof fetch,
  previewLocation: PreviewLocation,
  serverRouteBase: string,
): typeof fetch {
  const readBody = async (request: Request) => {
    const blob = await request.blob();
    return new Uint8Array(await blob.arrayBuffer());
  };
  const methodSupportsBody = (method: string) =>
    method !== "GET" && method !== "HEAD";

  return async (input, init) => {
    const isRequest = input instanceof Request;
    const url = new URL(
      isRequest ? input.url : String(input),
      previewLocation.href,
    );
    if (
      url.origin === previewLocation.origin &&
      !url.pathname.startsWith("/api/serverless/tanstack-start/")
    ) {
      const inheritedBody =
        isRequest &&
        init?.body === undefined &&
        methodSupportsBody(input.method)
          ? await readBody(init === undefined ? input : input.clone())
          : undefined;
      const sourceRequest =
        input instanceof Request && init === undefined
          ? input
          : input instanceof Request
            ? new Request(input, init)
            : new Request(url, init);
      // Firefox does not copy a Request body when the Request is used as a
      // RequestInit dictionary for a different URL. Materialize the body so
      // every browser sends the same bytes through the route gateway.
      const body =
        inheritedBody ??
        (methodSupportsBody(sourceRequest.method)
          ? await readBody(sourceRequest)
          : undefined);
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
          signal: sourceRequest.signal,
        },
      );
    }
    return nativeFetch(input, init);
  };
}
