import { cacheLife, cacheTag } from "next/cache";
import { readCacheMissSnapshot } from "./state";

export async function getCachedSnapshot() {
  "use cache";
  cacheLife({ stale: 300, revalidate: 3600, expire: 86400 });
  cacheTag("tuto-counter");
  return readCacheMissSnapshot();
}
