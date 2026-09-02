import { Suspense } from "react";
import { connection } from "next/server";
import { incrementCounter } from "./actions";
import { getCachedSnapshot } from "./data";

export default function Page() {
  return (
    <Suspense fallback={<p>Loading cache probe…</p>}>
      <RuntimeProbe />
    </Suspense>
  );
}

async function RuntimeProbe() {
  await connection();
  const snapshot = await getCachedSnapshot();

  return (
    <main>
      <h1>Tuto cache runtime probe</h1>
      <p data-cache-value={snapshot.value}>Value: {snapshot.value}</p>
      <p data-cache-executions={snapshot.cacheExecutions}>
        Cache executions: {snapshot.cacheExecutions}
      </p>
      <form action={incrementCounter}>
        <button type="submit">Increment and update tag</button>
      </form>
    </main>
  );
}
