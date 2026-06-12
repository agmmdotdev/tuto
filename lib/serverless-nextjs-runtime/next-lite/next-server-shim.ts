const redirectStatuses = new Set([301, 302, 303, 307, 308]);

export class NextResponse extends Response {
  static json<JsonBody>(
    body: JsonBody,
    init: ResponseInit = {},
  ): NextResponse {
    const headers = new Headers(init.headers);
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    return new NextResponse(JSON.stringify(body), {
      ...init,
      headers,
    });
  }

  static redirect(url: string | URL, init: number | ResponseInit = 307): NextResponse {
    const responseInit = typeof init === "number" ? { status: init } : init;
    const status = responseInit.status ?? 307;

    if (!redirectStatuses.has(status)) {
      throw new RangeError(
        `NextResponse.redirect() status must be one of 301, 302, 303, 307, or 308. Received ${status}.`,
      );
    }

    const headers = new Headers(responseInit.headers);
    headers.set("location", String(url));

    return new NextResponse(null, {
      ...responseInit,
      status,
      headers,
    });
  }
}
