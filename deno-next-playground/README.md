# Deno Next Playground

This is a separate minimal Next.js app intended for Deno Deploy experimentation.

It is intentionally isolated from the root app, which is Yarn 4 and Node-runtime heavy.

## What it includes

- App Router home page
- a small route handler at `/api/hello`
- Deno-first task configuration in `deno.json`

## Local development

```bash
cd deno-next-playground
deno task dev
```

## Build

```bash
cd deno-next-playground
deno task build
```

## Deploy

Point Deno Deploy at the `deno-next-playground` directory as the project root.
