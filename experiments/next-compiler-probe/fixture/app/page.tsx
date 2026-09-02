import { createLesson } from "./actions";
import { Counter } from "./components/counter";

async function ServerGreeting() {
  await Promise.resolve();
  return <p data-server-component="greeting">Hello from a Server Component</p>;
}
export default async function HomePage() {
  return (
    <main>
      <h1>Tuto compiler probe home</h1>
      <ServerGreeting />
      <Counter />
      <form action={createLesson}>
        <input name="title" defaultValue="compiler-action-worked" />
        <button type="submit">Create lesson</button>
      </form>
    </main>
  );
}
