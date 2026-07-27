# Media Drop Demonstration

Media Drop introduces R2 object storage while reusing Workers, D1, Static Assets, and Cloudflare Access. It demonstrates a public library and an authenticated creator Studio on one hostname, without ever exposing the R2 bucket directly.

## What It Shows

- R2 holds media bytes while D1 holds only searchable, owner-scoped metadata.
- An uploaded file streams from the request into R2 and starts as a private draft.
- Cloudflare Access is optional at the hostname level: public library traffic is bypassed, while Studio traffic has a verified identity.
- The Worker permits draft content only to its verified owner and serves published content to everyone, including byte ranges for audio and video.
- Deletion removes the R2 object first and then its D1 metadata.

## Before Presenting

1. Deploy with `npm run deploy`.
2. Open a private browser window for the anonymous part of the presentation.
3. Prepare a small PNG, MP3, or MP4 under 100 MB.
4. Keep Workers Logs, the R2 bucket, and D1 database consoles available.

## Presentation Flow

1. Open `https://media.cfapps.uk/` anonymously. The public library loads without a sign-in prompt.
2. Open `/studio`. Cloudflare Access asks the visitor to sign in, demonstrating the more-specific protected application on the same hostname.
3. In Studio, upload the prepared media with a title. It appears under **Drafts** and is visible only to that creator.
4. In the anonymous window, refresh the library and attempt the draft's URL if known. It is neither listed nor available through the public API.
5. Back in Studio, use the draft's preview or download control. The owner can stream private content through the authorized Worker.
6. Publish the draft. Refresh the anonymous library: the item appears with metadata, inline playback where applicable, and a download action.
7. Open the public detail page and seek the audio or video. The Worker forwards R2 range handling so streaming works correctly.
8. Delete the item in Studio. Confirm it disappears from the public library, the R2 object is gone, and the matching D1 row is gone.

## Observability

Open **Workers & Pages** > **Media Drop** > **Logs** and locate the successful action events:

- `media_uploaded`
- `media_published`
- `media_downloaded`
- `media_deleted`

Each event has the media ID, content type, and byte size needed to follow the demonstration without logging object bytes or credentials. Automatic Workers tracing is enabled by Terraform as well.

## Resetting The Demo

Delete the test item through Studio between presentations. To remove the complete demo and all billable named resources, run `npm run teardown`; it empties R2 before Terraform destroys the Worker, D1 database, R2 bucket, custom domain, and Access applications.
