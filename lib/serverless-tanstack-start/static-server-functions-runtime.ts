import {
  createMiddleware,
  getDefaultSerovalPlugins,
} from "@tanstack/start-client-core";
import { fromJSON, toJSONAsync } from "seroval";

// Platform storage adapter for the pinned upstream middleware contract:
// TanStack/router@0caf6b9 packages/start-static-server-functions.

type StaticCachedResult = {
  context: unknown;
  result: unknown;
};

type StaticServerFunctionCollector = (entry: {
  body: string;
  url: string;
}) => void;

export const staticServerFunctionCollectorKey =
  "__TUTO_TANSTACK_START_STATIC_SERVER_FUNCTION_COLLECTOR__";
export const staticServerFunctionCachePrefix =
  "/__tsr/staticServerFnCache/";

async function sha1Hash(message: string) {
  const messageBytes = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-1", messageBytes);
  return Array.from(new Uint8Array(hashBuffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function jsonToFilenameSafeString(value: unknown) {
  const sortedKeysReplacer = (_key: string, nestedValue: unknown) =>
    nestedValue &&
    typeof nestedValue === "object" &&
    !Array.isArray(nestedValue)
      ? Object.keys(nestedValue)
          .sort()
          .reduce<Record<string, unknown>>((result, key) => {
            result[key] = (nestedValue as Record<string, unknown>)[key];
            return result;
          }, {})
      : nestedValue;
  return JSON.stringify(value ?? "", sortedKeysReplacer)
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "_");
}

async function getStaticCacheUrl(functionId: string, data: unknown) {
  const hash = jsonToFilenameSafeString(data);
  const filename = await sha1Hash(`${functionId}__${hash}`);
  return `${staticServerFunctionCachePrefix}${filename}.json`;
}

const staticClientCache =
  typeof document !== "undefined" ? new Map<string, StaticCachedResult>() : null;

async function fetchItem(functionId: string, data: unknown) {
  const url = await getStaticCacheUrl(functionId, data);
  const cached = staticClientCache?.get(url);
  if (cached) return cached;
  const response = await fetch(url, { method: "GET" });
  if (!response.ok) {
    throw new Error(
      `Unable to load static server function result: HTTP ${response.status}.`,
    );
  }
  const decoded = fromJSON(await response.json(), {
    plugins: getDefaultSerovalPlugins(),
  }) as StaticCachedResult;
  staticClientCache?.set(url, decoded);
  return decoded;
}

export const staticFunctionMiddleware = createMiddleware({ type: "function" })
  .client(async (context) => {
    if (
      process.env.NODE_ENV === "production" &&
      typeof document !== "undefined"
    ) {
      const response = await fetchItem(
        context.serverFnMeta.id,
        context.data,
      );
      return {
        result: response.result,
        context: {
          ...((context as unknown as { context?: Record<string, unknown> })
            .context ?? {}),
          ...((response.context as Record<string, unknown> | undefined) ?? {}),
        },
      } as never;
    }
    return context.next();
  })
  .server(async (context) => {
    const response = await context.next();
    if (process.env.NODE_ENV === "production") {
      const collector = (
        globalThis as typeof globalThis &
          Record<string, StaticServerFunctionCollector | undefined>
      )[staticServerFunctionCollectorKey];
      if (collector) {
        const url = await getStaticCacheUrl(
          context.serverFnMeta.id,
          context.data,
        );
        collector({
          body: JSON.stringify(
            await toJSONAsync(
              {
                result: (response as { result?: unknown }).result,
                context: (
                  context as unknown as {
                    sendContext?: unknown;
                  }
                ).sendContext,
              },
              { plugins: getDefaultSerovalPlugins() },
            ),
          ),
          url,
        });
      }
    }
    return response;
  });
