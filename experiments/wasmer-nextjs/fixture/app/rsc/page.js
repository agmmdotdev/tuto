import { connection } from "next/server";
import { submitLessonAction } from "./action";

export default async function RscLessonPage({ searchParams }) {
  await connection();
  const { action = "not-run" } = await searchParams;

  return (
    <main>
      <h1>Tuto RSC production marker: rsc-v2-student-edit</h1>
      <p>Server Action result: {action}</p>
      <form action={submitLessonAction}>
        <input name="message" defaultValue="server-action-worked" />
        <button type="submit">Run Server Action</button>
      </form>
    </main>
  );
}
