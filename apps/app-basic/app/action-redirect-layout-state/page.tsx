import RedirectHereForm from "./redirect-here-form";

export default async function ActionRedirectLayoutStatePage({
  searchParams,
}: {
  searchParams: Promise<{ done?: string }>;
}) {
  const { done } = await searchParams;
  return (
    <div>
      <h1>Action Redirect Layout State</h1>
      <p data-testid="done">{done ? "done" : "not done"}</p>
      <RedirectHereForm />
    </div>
  );
}
