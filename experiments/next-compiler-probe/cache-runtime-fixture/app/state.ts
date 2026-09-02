type ProbeState = {
  value: number;
  cacheExecutions: number;
};

const stateKey = Symbol.for("tuto.next-cache-runtime-probe");
const globalState = globalThis as typeof globalThis & {
  [stateKey]?: ProbeState;
};

const state = (globalState[stateKey] ??= {
  value: 0,
  cacheExecutions: 0,
});

export function incrementValue() {
  state.value += 1;
}

export function readCacheMissSnapshot() {
  state.cacheExecutions += 1;
  return {
    value: state.value,
    cacheExecutions: state.cacheExecutions,
  };
}
