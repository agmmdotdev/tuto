const features = [
  "App Router page rendering",
  "Route handler at /api/hello",
  "Deno-first deno.json tasks",
  "Small dependency surface for Deploy",
];

export default function HomePage() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: "32px",
      }}
    >
      <section
        style={{
          width: "min(760px, 100%)",
          border: "1px solid rgba(148, 163, 184, 0.2)",
          borderRadius: "24px",
          background: "rgba(15, 23, 42, 0.72)",
          backdropFilter: "blur(20px)",
          padding: "32px",
          boxShadow: "0 24px 120px rgba(15, 23, 42, 0.45)",
        }}
      >
        <p
          style={{
            margin: 0,
            fontSize: "12px",
            letterSpacing: "0.24em",
            textTransform: "uppercase",
            color: "#7dd3fc",
          }}
        >
          Deno Deploy Target
        </p>
        <h1 style={{ margin: "12px 0 0", fontSize: "40px", lineHeight: 1.1 }}>
          Minimal Next.js playground
        </h1>
        <p
          style={{
            margin: "16px 0 0",
            fontSize: "16px",
            lineHeight: 1.7,
            color: "#cbd5e1",
          }}
        >
          This subapp exists to keep Deno Deploy experiments separate from the
          main project. It stays small, App Router based, and avoids the
          heavier Node runtime features from the root app.
        </p>

        <div
          style={{
            marginTop: "24px",
            display: "grid",
            gap: "12px",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          }}
        >
          {features.map((feature) => (
            <article
              key={feature}
              style={{
                borderRadius: "16px",
                border: "1px solid rgba(125, 211, 252, 0.18)",
                background: "rgba(15, 23, 42, 0.86)",
                padding: "16px",
                color: "#e2e8f0",
              }}
            >
              {feature}
            </article>
          ))}
        </div>

        <div
          style={{
            marginTop: "24px",
            display: "flex",
            flexWrap: "wrap",
            gap: "12px",
          }}
        >
          <a
            href="/api/hello"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              minWidth: "180px",
              padding: "12px 16px",
              borderRadius: "999px",
              background: "#38bdf8",
              color: "#082f49",
              textDecoration: "none",
              fontWeight: 700,
            }}
          >
            Open /api/hello
          </a>
          <a
            href="https://docs.deno.com/examples/next_tutorial/"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              minWidth: "180px",
              padding: "12px 16px",
              borderRadius: "999px",
              border: "1px solid rgba(148, 163, 184, 0.32)",
              textDecoration: "none",
              color: "#e2e8f0",
            }}
          >
            Deno tutorial
          </a>
        </div>
      </section>
    </main>
  );
}
