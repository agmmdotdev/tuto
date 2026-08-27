type PreviewLocation = {
  href: string;
  origin: string;
};

export function createTanstackStartRouteFetch(
  nativeFetch: typeof fetch,
  previewLocation: PreviewLocation,
  serverRouteBase: string,
): typeof fetch {
  return (input, init) => {
    const isRequest = input instanceof Request;
    const url = new URL(
      isRequest ? input.url : String(input),
      previewLocation.href,
    );
    if (
      url.origin === previewLocation.origin &&
      !url.pathname.startsWith("/api/serverless/tanstack-start/")
    ) {
      const sourceRequest = isRequest
        ? new Request(input, init)
        : new Request(url, init);
      const gatewayRequest = new Request(
        serverRouteBase + encodeURIComponent(url.pathname + url.search),
        sourceRequest,
      );
      return nativeFetch(
        new Request(gatewayRequest, { credentials: "include" }),
      );
    }
    return nativeFetch(input, init);
  };
}
