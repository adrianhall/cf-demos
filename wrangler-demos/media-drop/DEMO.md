# Media Drop Demo Script

See [`EXPLAIN-DEMO.md`](./EXPLAIN-DEMO.md) for what this demo teaches.

## Demonstration Prerequisites

1. Deploy the demo with `npm run deploy` from `demos/media-drop`.
2. Prepare a small sample image, audio file, and/or short video (under 100 MB) ready to upload.
3. Confirm you can authenticate through the configured identity provider.
4. Open two dashboard tabs: **R2** > the `<DEMO_NAME>-store` bucket browser, and **D1** > the `<DEMO_NAME>-db` console (`SELECT * FROM media;`).
5. Open a third dashboard tab to **Workers & Pages** > `<DEMO_NAME>` > **Logs**.
6. Open a private/incognito browser window for the anonymous parts of the presentation.

## Presentation Flow

1. In the incognito window, open `https://media.cfapps.uk/`. Show the public library loads with no sign-in prompt, and that there is no Studio link or affordance for an anonymous visitor.
2. In your normal browser, open `/studio`. Show Cloudflare Access requesting sign-in, then authenticate.
3. In Studio, use **Upload media** to upload the prepared file with a title. Show it appears under **Drafts**, visible only to you.
4. Switch to the incognito window, refresh the library, and show the draft is not listed. Attempting its detail or content URL directly also fails — drafts are never served to anonymous visitors.
5. Back in Studio, use the draft's preview/download control and show the owner can stream their own private content through the authorized Worker.
6. Publish the draft.
7. Switch to the incognito window and refresh the public library. Show the item now appears with metadata, inline playback where applicable, and a download control. Open the detail page and, for audio/video, seek partway through to show range-request streaming working.
8. Back in Studio, delete the item.
9. Switch to the incognito window and refresh the library — the item is gone.
10. Switch to the R2 bucket browser tab and refresh — the object is gone. Switch to the D1 console tab and re-run the query — the row is gone.
11. Switch to the Workers Logs tab and locate, in order, the `media_uploaded`, `media_published`, `media_downloaded`, and `media_deleted` events for this walkthrough. Open one and point out it contains only the media ID, content type, byte size, and caller — never object bytes or authorization headers.

## Expected Results

- Anonymous visitors can browse, view, stream, and download only published items; drafts are invisible and unreachable without authentication.
- The signed-in creator can preview and manage only their own items, whether draft or published.
- Deleting an item removes both the R2 object and the D1 metadata row — no orphaned object or row remains.
- Each successful upload, publish, download, and delete produces exactly one correlated, non-sensitive log event.

## Where To Observe State

- **Worker logs:** Workers & Pages > `<DEMO_NAME>` > Logs; filter for `media_uploaded`, `media_published`, `media_downloaded`, `media_deleted`.
- **R2 bucket:** R2 > `<DEMO_NAME>-store`; objects are keyed `media/<owner-hash>/<id>`.
- **D1 database:** D1 > `<DEMO_NAME>-db`; query the `media` table for `status`, `owner`, and `r2_key`.
- **Access applications:** Zero Trust > Access controls > Applications; inspect the public library and studio applications and their policies.

Run `npm run teardown` after the presentation; see README.md for details.
