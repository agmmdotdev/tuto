"use client";

import { useState } from "react";

export function Counter() {
  const [count, setCount] = useState(0);
  return (
    <button data-client-component="counter" onClick={() => setCount(count + 1)}>
      Count: {count}
    </button>
  );
}
