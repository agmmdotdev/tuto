/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const { AsyncLocalStorage: NativeAsyncLocalStorage } = require("node:async_hooks");
if (globalThis.__TUTO_NEXT_SECURE_EXEC__ !== true) {
  globalThis.AsyncLocalStorage ??= NativeAsyncLocalStorage;
  module.exports = { AsyncLocalStorage: NativeAsyncLocalStorage };
  return;
}
delete globalThis.__TUTO_NEXT_SECURE_EXEC__;

const util = require("node:util");
const bridgeFetch = globalThis.fetch;
util.TextEncoder ??= globalThis.TextEncoder;
util.TextDecoder ??= globalThis.TextDecoder;
if (typeof globalThis.TextEncoder.prototype.encodeInto !== "function") {
  globalThis.TextEncoder.prototype.encodeInto = function encodeInto(
    source,
    destination,
  ) {
    const encoded = this.encode(source);
    const written = Math.min(encoded.byteLength, destination.byteLength);
    destination.set(encoded.subarray(0, written));
    return {
      read: written === encoded.byteLength ? source.length : 0,
      written,
    };
  };
}

const streams = require("web-streams-polyfill");
for (const name of [
  "ReadableStream",
  "ReadableStreamBYOBReader",
  "ReadableStreamDefaultReader",
  "TransformStream",
  "WritableStream",
  "WritableStreamDefaultWriter",
]) {
  globalThis[name] ??= streams[name];
}

if (typeof globalThis.Event !== "function") {
  globalThis.Event = class Event {
    constructor(type) {
      this.type = String(type);
    }
  };
}
if (typeof globalThis.EventTarget !== "function") {
  globalThis.EventTarget = class EventTarget {
    constructor() {
      this._listeners = new Map();
    }

    addEventListener(type, callback) {
      if (typeof callback !== "function") return;
      const key = String(type);
      const listeners = this._listeners.get(key) ?? new Set();
      listeners.add(callback);
      this._listeners.set(key, listeners);
    }

    removeEventListener(type, callback) {
      this._listeners.get(String(type))?.delete(callback);
    }

    dispatchEvent(event) {
      for (const callback of this._listeners.get(String(event.type)) ?? []) {
        callback.call(this, event);
      }
      return true;
    }
  };
}

const cryptoEndpoint = globalThis.__TUTO_NEXT_CRYPTO_ENDPOINT__;
delete globalThis.__TUTO_NEXT_CRYPTO_ENDPOINT__;
if (typeof cryptoEndpoint === "string") {
  const callCrypto = async (operation, input) => {
    const response = await bridgeFetch(cryptoEndpoint, {
      body: JSON.stringify({ input, operation }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error ?? "The Web Crypto bridge failed.");
    }
    return Uint8Array.from(Buffer.from(payload.value, "base64")).buffer;
  };
  crypto.subtle.importKey = async (format, keyData, algorithm, extractable, usages) => {
    if (format !== "raw") throw new Error("SecureExec supports raw Web Crypto keys only.");
    return {
      algorithm,
      extractable,
      type: "secret",
      usages,
      __tutoRawKey: Buffer.from(new Uint8Array(keyData)).toString("base64"),
    };
  };
  crypto.subtle.encrypt = (algorithm, key, data) =>
    callCrypto("encrypt", {
      algorithm: {
        name: algorithm.name,
        iv: Buffer.from(algorithm.iv).toString("base64"),
      },
      data: Buffer.from(new Uint8Array(data)).toString("base64"),
      key: key.__tutoRawKey,
    });
  crypto.subtle.decrypt = (algorithm, key, data) =>
    callCrypto("decrypt", {
      algorithm: {
        name: algorithm.name,
        iv: Buffer.from(algorithm.iv).toString("base64"),
      },
      data: Buffer.from(new Uint8Array(data)).toString("base64"),
      key: key.__tutoRawKey,
    });
  crypto.subtle.digest = (algorithm, data) =>
    callCrypto("digest", {
      algorithm: typeof algorithm === "string" ? algorithm : algorithm.name,
      data: Buffer.from(new Uint8Array(data)).toString("base64"),
    });
}

const headerLists = new WeakMap();
const headersSet = Headers.prototype.set;
const headersDelete = Headers.prototype.delete;
Headers.prototype.set = function set(name, value) {
  const key = String(name).toLowerCase();
  let lists = headerLists.get(this);
  if (!lists) headerLists.set(this, (lists = new Map()));
  lists.set(key, [String(value)]);
  return headersSet.call(this, name, String(value));
};
Headers.prototype.delete = function deleteHeader(name) {
  headerLists.get(this)?.delete(String(name).toLowerCase());
  return headersDelete.call(this, name);
};
Headers.prototype.append ??= function append(name, value) {
  const key = String(name).toLowerCase();
  let lists = headerLists.get(this);
  if (!lists) headerLists.set(this, (lists = new Map()));
  const values = lists.get(key) ??
    (this.get(key) === null ? [] : [String(this.get(key))]);
  values.push(String(value));
  lists.set(key, values);
  return headersSet.call(this, key, values.join(", "));
};
Headers.prototype.getSetCookie ??= function getSetCookie() {
  const values = headerLists.get(this)?.get("set-cookie");
  if (values) return [...values];
  const value = this.get("set-cookie");
  return value === null ? [] : [String(value)];
};

function bodyBytes(body) {
  if (body === null || body === undefined) return Promise.resolve(new Uint8Array());
  if (body instanceof Uint8Array) return Promise.resolve(new Uint8Array(body));
  if (body instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(body));
  if (typeof body === "string") {
    return Promise.resolve(new TextEncoder().encode(body));
  }
  if (typeof body.arrayBuffer === "function") {
    return body.arrayBuffer().then((value) => new Uint8Array(value));
  }
  if (
    typeof body.getReader === "function" ||
    typeof body[Symbol.asyncIterator] === "function"
  ) {
    return (async () => {
      const chunks = [];
      let size = 0;
      for await (const chunk of body) {
        const bytes =
          typeof chunk === "string"
            ? new TextEncoder().encode(chunk)
            : new Uint8Array(chunk);
        chunks.push(bytes);
        size += bytes.byteLength;
      }
      const result = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return result;
    })();
  }
  return Promise.resolve(new TextEncoder().encode(String(body)));
}

class TutoFile extends Blob {
  constructor(parts, name, options = {}) {
    super();
    this.name = String(name);
    this.type = String(options.type ?? "").toLowerCase();
    this.lastModified = Number(options.lastModified ?? Date.now());
    this._parts = (parts ?? []).map((part) =>
      typeof part === "string"
        ? new TextEncoder().encode(part)
        : part instanceof ArrayBuffer
          ? new Uint8Array(part)
          : new Uint8Array(part.buffer, part.byteOffset, part.byteLength),
    );
    this.size = this._parts.reduce((total, part) => total + part.byteLength, 0);
  }

  async arrayBuffer() {
    const result = new Uint8Array(this.size);
    let offset = 0;
    for (const part of this._parts) {
      result.set(part, offset);
      offset += part.byteLength;
    }
    return result.buffer;
  }

  async text() {
    return new TextDecoder().decode(await this.arrayBuffer());
  }

  stream() {
    const bytes = this.arrayBuffer();
    return new ReadableStream({
      async start(controller) {
        controller.enqueue(new Uint8Array(await bytes));
        controller.close();
      },
    });
  }
}

class TutoFormData {
  constructor() {
    this._entries = [];
  }

  append(name, value, filename) {
    const normalized =
      filename === undefined || typeof value === "string"
        ? value
        : new TutoFile([value], filename, { type: value.type });
    this._entries.push([String(name), normalized]);
  }

  delete(name) {
    const key = String(name);
    this._entries = this._entries.filter(([entry]) => entry !== key);
  }

  get(name) {
    return this._entries.find(([entry]) => entry === String(name))?.[1] ?? null;
  }

  getAll(name) {
    return this._entries
      .filter(([entry]) => entry === String(name))
      .map(([, value]) => value);
  }

  has(name) {
    return this._entries.some(([entry]) => entry === String(name));
  }

  set(name, value, filename) {
    this.delete(name);
    this.append(name, value, filename);
  }

  entries() {
    return this._entries[Symbol.iterator]();
  }

  keys() {
    return this._entries.map(([name]) => name)[Symbol.iterator]();
  }

  values() {
    return this._entries.map(([, value]) => value)[Symbol.iterator]();
  }

  forEach(callback, thisArg) {
    for (const [name, value] of this._entries) {
      callback.call(thisArg, value, name, this);
    }
  }

  [Symbol.iterator]() {
    return this.entries();
  }
}

globalThis.File ??= TutoFile;
globalThis.FormData ??= TutoFormData;

function bodyStream(body) {
  if (body === null || body === undefined) return null;
  if (typeof body.getReader === "function") return body;
  return new ReadableStream({
    async start(controller) {
      controller.enqueue(await bodyBytes(body));
      controller.close();
    },
  });
}

Object.defineProperty(Response.prototype, "body", {
  configurable: true,
  get() {
    return bodyStream(this._body);
  },
});
Response.prototype.arrayBuffer = async function arrayBuffer() {
  return (await bodyBytes(this._body)).buffer;
};
Response.prototype.text = async function text() {
  const bytes = await bodyBytes(this._body);
  return new TextDecoder().decode(bytes);
};
Response.prototype.json = async function json() {
  return JSON.parse(await this.text());
};
Response.json ??= function json(value, init = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return new Response(JSON.stringify(value), { ...init, headers });
};
Response.prototype.clone = function clone() {
  const response = new Response(this._body, {
    headers: this.headers,
    status: this.status,
    statusText: this.statusText,
  });
  response.redirected = this.redirected;
  response.url = this.url;
  return response;
};

globalThis.__TUTO_NEXT_ORIGIN_FETCH__ = async function nextOriginFetch(
  input,
  init,
) {
  const raw = await bridgeFetch(input, init);
  const headers = new Headers(
    typeof raw.headers?.entries === "function"
      ? [...raw.headers.entries()]
      : raw.headers,
  );
  const rawBody = await raw.text();
  const body =
    headers.get("x-body-encoding") === "base64"
      ? Buffer.from(rawBody, "base64")
      : rawBody;
  headers.delete("x-body-encoding");
  const response = new Response(body, {
    headers,
    status: raw.status,
    statusText: raw.statusText,
  });
  response.redirected = raw.redirected;
  response.url = raw.url;
  return response;
};

Request.prototype.arrayBuffer ??= async function arrayBuffer() {
  return (await bodyBytes(this.body)).buffer;
};
Request.prototype.text ??= async function text() {
  return new TextDecoder().decode(await bodyBytes(this.body));
};
Request.prototype.json ??= async function json() {
  return JSON.parse(await this.text());
};

const HostAsyncLocalStorage = NativeAsyncLocalStorage;

function restore(storage, value) {
  if (value === undefined) storage.disable();
  else storage.enterWith(value);
}

function settleWithRestore(value, callback) {
  if (value && typeof value.then === "function") {
    return Promise.resolve(value).finally(callback);
  }
  callback();
  return value;
}

if (
  typeof HostAsyncLocalStorage.snapshot !== "function" ||
  typeof HostAsyncLocalStorage.bind !== "function"
) {
  const instances = new Set();
  class CompatibleAsyncLocalStorage extends HostAsyncLocalStorage {
    constructor() {
      super();
      instances.add(this);
    }

    run(store, callback, ...args) {
      const previous = this.getStore();
      this.enterWith(store);
      try {
        return settleWithRestore(callback(...args), () =>
          restore(this, previous),
        );
      } catch (error) {
        restore(this, previous);
        throw error;
      }
    }

    exit(callback, ...args) {
      const previous = this.getStore();
      this.disable();
      try {
        return settleWithRestore(callback(...args), () =>
          restore(this, previous),
        );
      } catch (error) {
        restore(this, previous);
        throw error;
      }
    }

    static snapshot() {
      const captured = [...instances].map((storage) => [
        storage,
        storage.getStore(),
      ]);
      return (callback, ...args) => {
        const previous = captured.map(([storage]) => [
          storage,
          storage.getStore(),
        ]);
        for (const [storage, value] of captured) restore(storage, value);
        try {
          return settleWithRestore(callback(...args), () => {
            for (const [storage, value] of previous) restore(storage, value);
          });
        } catch (error) {
          for (const [storage, value] of previous) restore(storage, value);
          throw error;
        }
      };
    }

    static bind(callback) {
      const snapshot = this.snapshot();
      return (...args) => snapshot(callback, ...args);
    }
  }
  globalThis.AsyncLocalStorage = CompatibleAsyncLocalStorage;
} else {
  globalThis.AsyncLocalStorage ??= HostAsyncLocalStorage;
}

module.exports = {
  AsyncLocalStorage: globalThis.AsyncLocalStorage,
};
