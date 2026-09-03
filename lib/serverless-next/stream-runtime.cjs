 
"use strict";

const defaultMaxStreamBytes = 16 * 1024 * 1024;
const maxChunkBytes = 256 * 1024;
const maxOpenStreams = 8;
let nextStreamId = 1;

function streamId() {
  const id = `stream:${nextStreamId}`;
  nextStreamId += 1;
  return id;
}

function byteChunk(value) {
  if (typeof value === "string") return Buffer.from(value);
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError("A streamed response produced a non-byte chunk.");
}

function createOutputStreamRegistry() {
  const streams = new Map();

  function finish(id, entry, error, value) {
    if (streams.get(id) !== entry) return;
    streams.delete(id);
    if (error) entry.rejectCompletion(error);
    else entry.resolveCompletion(value);
  }

  function register(stream, options = {}) {
    if (!stream || typeof stream.getReader !== "function") {
      throw new TypeError("A Web ReadableStream is required.");
    }
    if (streams.size >= maxOpenStreams) {
      throw new Error("The worker has too many open response streams.");
    }
    const id = streamId();
    let resolveCompletion;
    let rejectCompletion;
    const completion = new Promise((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    // The lifecycle owner observes completion; suppress an unhandled rejection
    // if a caller only uses the message protocol.
    void completion.catch(() => undefined);
    const entry = {
      bytes: 0,
      completion,
      maxBytes: options.maxBytes ?? defaultMaxStreamBytes,
      onDone: options.onDone,
      pending: [],
      reader: stream.getReader(),
      rejectCompletion,
      resolveCompletion,
    };
    streams.set(id, entry);
    return { completion, id };
  }

  async function pull(id) {
    const entry = streams.get(id);
    if (!entry) throw new Error(`Unknown or closed response stream ${id}.`);
    try {
      let chunk = entry.pending.shift();
      if (!chunk) {
        const result = await entry.reader.read();
        if (result.done) {
          const streamFinal = await entry.onDone?.();
          finish(id, entry, undefined, streamFinal);
          return { streamDone: true, streamFinal };
        }
        chunk = byteChunk(result.value);
        entry.bytes += chunk.byteLength;
        if (entry.bytes > entry.maxBytes) {
          await entry.reader.cancel("Response stream limit exceeded.");
          throw new Error(
            `The streamed response exceeds the ${entry.maxBytes} byte limit.`,
          );
        }
        if (chunk.byteLength > maxChunkBytes) {
          for (let offset = maxChunkBytes; offset < chunk.byteLength; offset += maxChunkBytes) {
            entry.pending.push(chunk.subarray(offset, offset + maxChunkBytes));
          }
          chunk = chunk.subarray(0, maxChunkBytes);
        }
      }
      return {
        streamChunkBase64: chunk.toString("base64"),
        streamDone: false,
      };
    } catch (error) {
      finish(id, entry, error);
      throw error;
    }
  }

  async function cancel(id, reason = "Response stream cancelled.") {
    const entry = streams.get(id);
    if (!entry) return { streamCancelled: false };
    try {
      await entry.reader.cancel(reason);
      finish(id, entry);
      return { streamCancelled: true };
    } catch (error) {
      finish(id, entry, error);
      throw error;
    }
  }

  async function close() {
    await Promise.all(
      [...streams.entries()].map(([id]) => cancel(id, "Worker closing.")),
    );
  }

  return { cancel, close, pull, register };
}

function createInputStreamRegistry() {
  const streams = new Map();

  function open() {
    if (streams.size >= maxOpenStreams) {
      throw new Error("The worker has too many open request streams.");
    }
    const id = streamId();
    const entry = {
      closed: false,
      controller: undefined,
      pullCount: 0,
      waiters: new Set(),
    };
    const stream = new ReadableStream({
      start(controller) {
        entry.controller = controller;
      },
      pull() {
        entry.pullCount += 1;
        for (const resolve of entry.waiters) resolve();
        entry.waiters.clear();
      },
      cancel() {
        entry.closed = true;
        streams.delete(id);
        for (const resolve of entry.waiters) resolve();
        entry.waiters.clear();
      },
    });
    streams.set(id, entry);
    return { id, stream };
  }

  async function write(id, chunkBase64, done) {
    const entry = streams.get(id);
    if (!entry || entry.closed || !entry.controller) {
      throw new Error(`Unknown or closed request stream ${id}.`);
    }
    if (typeof chunkBase64 === "string" && chunkBase64.length > 0) {
      const beforePull = entry.pullCount;
      entry.controller.enqueue(Buffer.from(chunkBase64, "base64"));
      if (entry.controller.desiredSize !== null && entry.controller.desiredSize <= 0 && entry.pullCount === beforePull) {
        await new Promise((resolve) => entry.waiters.add(resolve));
      }
    }
    if (done && !entry.closed) {
      entry.closed = true;
      streams.delete(id);
      entry.controller.close();
    }
    return { streamAccepted: true };
  }

  function error(id, message) {
    const entry = streams.get(id);
    if (!entry || entry.closed || !entry.controller) return { streamErrored: false };
    entry.closed = true;
    streams.delete(id);
    entry.controller.error(new Error(message || "Request stream failed."));
    for (const resolve of entry.waiters) resolve();
    entry.waiters.clear();
    return { streamErrored: true };
  }

  return { error, open, write };
}

module.exports = {
  createInputStreamRegistry,
  createOutputStreamRegistry,
  defaultMaxStreamBytes,
};
