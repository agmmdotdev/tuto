export default async function PostPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <h1 data-dynamic-route={id}>Dynamic post: {id}</h1>;
}
