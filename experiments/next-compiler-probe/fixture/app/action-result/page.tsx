export default async function ActionResultPage({
  searchParams,
}: {
  searchParams: Promise<{ title?: string }>;
}) {
  const { title = "missing" } = await searchParams;
  return <h1>Server Action result: {title}</h1>;
}
