"use strict";

// Keep an absolute deadline from the value's original timestamp, never from
// ticket publication. Background writes cannot renew a render's stale reads.
function recordCacheLifetime(dependencies, timestamp, lifetimes, stale = false) {
  if (!dependencies) return;
  let deadline = 0;
  if (!stale && Number.isFinite(timestamp) && timestamp >= 0 &&
      lifetimes.length && lifetimes.every(value => value === false ||
        (Number.isFinite(value) && value >= 0))) {
    deadline = Math.min(...lifetimes.map(value => value === false
      ? Infinity : timestamp + value * 1000));
  }
  if (deadline !== Infinity) {
    dependencies.expiresAt = Math.min(dependencies.expiresAt ?? Infinity, deadline);
  }
}

module.exports = { recordCacheLifetime };
