# Spike 08: Local Workflow Orchestration

Disposable local proof for the ArchitectureWorkflow binding layout: Cloudflare Workflows, D1, R2, and a SQLite Durable Object run only through local Wrangler/workerd. It contains no Workers AI binding and no remote binding.

```sh
npm install
npm run db:migrate:local
npm run check:types
npm test
npm run dev
```

With `npm run dev` running, submit a fixture locally:

```sh
curl -X POST http://127.0.0.1:8787/jobs \
  -d '{"jobId":"manual-valid","diagramId":"manual-diagram","baseRevision":1,"fixture":"valid"}'
npx wrangler workflows instances describe spike-08-architecture-workflow manual-valid --local
```

Use `npx wrangler workflows list --local`, `... instances describe ... --local`, or the local explorer at `http://127.0.0.1:8787/cdn-cgi/explorer` to inspect locally running instances. See `REPORT.md` for verified findings and limitations.
