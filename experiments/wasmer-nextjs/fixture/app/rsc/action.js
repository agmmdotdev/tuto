"use server";

import { redirect } from "next/navigation";

export async function submitLessonAction(formData) {
  const message = String(formData.get("message") ?? "missing");
  redirect(`/rsc?action=action-v2-${encodeURIComponent(message)}`);
}
