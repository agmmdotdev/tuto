"use server";

import { updateTag } from "next/cache";
import { incrementValue } from "./state";

export async function incrementCounter() {
  incrementValue();
  updateTag("tuto-counter");
}
