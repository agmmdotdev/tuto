import { archiveLesson } from "../actions";

export default function NewStudentRoute() {
  return (
    <main>
      <h1>Student-created route</h1>
      <form action={archiveLesson}>
        <input name="title" defaultValue="new-action-worked" />
        <button type="submit">Archive lesson</button>
      </form>
    </main>
  );
}
