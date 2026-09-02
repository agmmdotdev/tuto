"use server";

import { redirect } from "next/navigation";

export async function createLesson(formData: FormData) {
  const title = String(formData.get("title") ?? "missing");
  redirect(`/action-result?title=${encodeURIComponent(title)}`);
}

export async function archiveLesson(formData: FormData) {
  const title = String(formData.get("title") ?? "missing");
  redirect(`/action-result?title=archived-${encodeURIComponent(title)}`);
}
