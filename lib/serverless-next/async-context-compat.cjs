"use strict";

// SecureExec 0.1.0's ALS only scopes synchronous calls. Framework requests are
// serialized and held until their streams settle. Retain each scope by identity
// so a shorter cache-fill/snapshot cannot restore a stale saved value over a
// still-active scope. This is a bounded framework compatibility layer, not a
// general replacement for Node's async_hooks propagation.
function createCompatibleAsyncLocalStorage(NativeAsyncLocalStorage) {
  const instances = new Set();
  class CompatibleAsyncLocalStorage extends NativeAsyncLocalStorage {
    constructor() {
      super();
      this.frames = [];
      this.base = undefined;
      instances.add(this);
    }

    getStore() {
      return this.frames.length
        ? this.frames[this.frames.length - 1].value
        : this.base;
    }

    enterWith(value) {
      if (this.frames.length) this.frames[this.frames.length - 1].value = value;
      else this.base = value;
    }

    disable() {
      this.frames.length = 0;
      this.base = undefined;
    }

    scope(value) {
      const frame = { value };
      this.frames.push(frame);
      return () => {
        const index = this.frames.indexOf(frame);
        if (index !== -1) this.frames.splice(index, 1);
      };
    }

    run(store, callback, ...args) {
      const finish = this.scope(store);
      try {
        const value = callback(...args);
        if (value && typeof value.then === "function")
          return Promise.resolve(value).finally(finish);
        finish();
        return value;
      } catch (error) {
        finish();
        throw error;
      }
    }

    exit(callback, ...args) {
      return this.run(undefined, callback, ...args);
    }

    static snapshot() {
      const captured = [...instances].map((storage) => [
        storage,
        storage.getStore(),
      ]);
      return (callback, ...args) => {
        const finishes = captured.map(([storage, value]) =>
          storage.scope(value),
        );
        const finish = () => {
          for (const release of finishes) release();
        };
        // The snapshot selects the synchronous entry context. Nested run()
        // scopes own their asynchronous lifetime; keeping the clean snapshot
        // until its returned promise settles would mask the outer request while
        // a cache stream/write continues after the caller receives its result.
        try {
          return callback(...args);
        } finally {
          finish();
        }
      };
    }

    static bind(callback) {
      const snapshot = this.snapshot();
      return function (...args) {
        return snapshot(() => callback.apply(this, args));
      };
    }
  }
  return CompatibleAsyncLocalStorage;
}

// Native await continuations bypass Promise.prototype.then. Learner server
// modules are lowered to SWC's generator helper so each continuation can select
// its invocation snapshot, including caught failures and nested async calls.
function contextualAsyncToGenerator(fn) {
  return function (...args) {
    const resume = globalThis.AsyncLocalStorage.snapshot();
    return new Promise((resolve, reject) => {
      const generator = fn.apply(this, args);
      function step(kind, value) {
        resume(() => {
          let result;
          try {
            result = generator[kind](value);
          } catch (error) {
            reject(error);
            return;
          }
          if (result.done) resolve(result.value);
          else
            Promise.resolve(result.value).then(
              (value) => step("next", value),
              (error) => step("throw", error),
            );
        });
      }
      step("next", undefined);
    });
  };
}

function installContextCallbacks(Storage) {
  const originalThen = Promise.prototype.then;
  Promise.prototype.then = function then(onFulfilled, onRejected) {
    return originalThen.call(
      this,
      typeof onFulfilled === "function"
        ? Storage.bind(onFulfilled)
        : onFulfilled,
      typeof onRejected === "function" ? Storage.bind(onRejected) : onRejected,
    );
  };
  for (const name of [
    "setTimeout",
    "setInterval",
    "setImmediate",
    "queueMicrotask",
  ]) {
    const original = globalThis[name];
    if (typeof original !== "function") continue;
    globalThis[name] = function (callback, ...args) {
      return original.call(
        this,
        typeof callback === "function" ? Storage.bind(callback) : callback,
        ...args,
      );
    };
  }
}

module.exports = {
  createCompatibleAsyncLocalStorage,
  contextualAsyncToGenerator,
  installContextCallbacks,
};
