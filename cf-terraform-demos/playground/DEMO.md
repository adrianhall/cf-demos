# Presenting the Playground

A walkthrough for showing this demo to an audience. It assumes the application is deployed and you
can sign in; see [`README.md`](./README.md) for prerequisites, deployment, and teardown.

The sequence below runs about **25 minutes** at a comfortable pace. Every section is self-contained,
so you can drop any of them and the rest still makes sense — the dependencies are noted where they
exist.

## Before you start

**Check whether the account has prepaid AI Gateway credits.** This single fact decides a third of
the walkthrough. Twelve of the fifteen inference panels use Cloudflare-hosted models and cost
nothing but Workers AI usage; **Create Video, Animate Image, and Generate Music have no hosted
option at all** and bill against prepaid credits. On an unfunded account they fail with a clear "add
credit" notice rather than an error — which is itself worth showing, but not worth being surprised
by.

Decide in advance which version you are giving:

|                   | Funded account        | Unfunded account                                      |
| ----------------- | --------------------- | ----------------------------------------------------- |
| Sections 1–5, 7   | As written            | As written                                            |
| Section 6 (media) | Generate a real video | Show the estimate and the credit notice, then move on |
| Running time      | ~25 min               | ~18 min                                               |

Two more things worth doing beforehand:

- **Open the AI Gateway dashboard in a second tab.** Section 7 is far more convincing when you can
  switch to it and show the request that just happened.
- **Have a photograph on your desktop.** Sections 3 and 4 both want one. A picture with two or three
  obvious objects in it — a street scene, people, animals — works better than a landscape.

## The one sentence to open with

> Every request this application makes to a model goes through AI Gateway — except for one, which is
> written down in a register the build checks, along with exactly what observability that costs.

That is the demo's actual subject, and the exception is part of it rather than a caveat to it. The
panels are how it gets demonstrated. Section 7 is where it lands.

---

## 1. Chat — the shape of a run (3 min)

Open **Chat** and send anything. While it streams, say what is happening underneath.

Then open **Run details** below the answer. Three things are worth pointing at:

- **The gateway log ID.** This is the thread between the application's own logs and the dashboard
  entry. If it is missing, the request never reached the gateway — its absence is a finding, not a
  blank field.
- **The cost, which may still say `Pending`.** Gateway logs take a moment to propagate. The panel
  says `Pending` rather than `$0.00`, and that is deliberate: a free run and an unmeasured run are
  different claims, and the UI never conflates them.
- **The session cost meter** in the sidebar, which has just moved for the first time.

**Ask the same question again.** If the model and gateway support caching, the second answer is
served from cache and the cost reflects it.

## 2. View Tokens — the panel that spends nothing (2 min)

Open **View Tokens** and paste the prompt from section 1.

The point of this panel is the contrast: it looks like every other one, and it makes no network
request at all. Tokenization happens in the browser. It creates no run, no gateway log, and no cost
— and the session meter does not move.

It is also the most useful panel for explaining why two prompts that look similar cost different
amounts. Paste something with unusual punctuation or a non-English phrase and show the token count
against the character count.

## 3. Create Image → Describe Image → Classify Image (5 min)

This is the strongest sequence in the demo because each panel hands off to the next.

1. **Create Image.** Generate something, using a prepared prompt if you want to save time. Note that
   the model's controls — steps, guidance, seed — are not a fixed set the UI invented; they come
   from the model's reviewed descriptor, so selecting a different model changes which controls
   exist.
2. **Hand it to Describe Image.** The picture never touches storage: it travels in the request.
3. **Hand the same picture to Classify Image.** Here the contrast is worth drawing out. Describe
   Image is generative and will write you a paragraph about anything; Classify Image scores the
   picture against a **fixed label set it was trained on**, and cannot invent a label outside it.

**The sentence worth saying slowly:** a confidence score is the model's measure of resemblance to
its training data. It is _not_ the probability that the label is correct, and it is not evidence
that the right category exists in the label set at all. The panel says so, and an architecture test
fails the build if any panel ever describes a score as a probability of correctness.

If someone asks why Classify Image refuses a prompt: because a classifier has nothing to be asked. A
body carrying one is rejected rather than ignored, so a caller who misunderstood the panel finds
out.

## 4. Detect Objects — _where_, not _what_ (3 min)

Upload your photograph and type a target — `person`, or something more specific like
`person wearing a red shirt`.

Two things make this panel worth its slot:

- **The label is your phrase, echoed back.** Unlike Classify Image, this model does not choose from
  a trained label set; it localises a description you supply. Try a natural-language target to show
  that it genuinely works.
- **There is no confidence score anywhere**, because the model returns four coordinates per region
  and nothing else. The panel does not invent one. That absence is the honest answer and it is
  stated rather than left as a gap in the page.

Try a target the picture does not contain. Finding nothing is a **successful run** with an empty
result, and the panel distinguishes that from a run that has not happened.

## 5. Semantic Search and Evaluate Choices (5 min)

**Semantic Search** first. Run the prepared password-reset query against the curated collection. The
semantic match outranks a passage with more words in common, which is the whole point.

Then switch the embedding model and run it again. **The scores change completely**, and that is the
lesson: 1,024 dimensions and 768 dimensions are different spaces, so a cosine of 0.7 in one means
nothing about 0.7 in the other. Scores are relative within one model and one query — never
comparable across models.

Run the same query twice and show the **cache indicators**: passage embeddings are content-derived
and cached, so the second search computes only the query embedding. The cost reflects it.

Then **Evaluate Choices**, which is the sharpest contrast in the application. Load the support
triage scenario and run it.

- The answer is **typed**: a probability, a choice, a score — not prose that happens to look like
  JSON. There is no parse step anywhere.
- **Confidence is separate from probability**, and they move independently. Run the routing question
  against a clear state, then against the text `Hello`. The probability stays high-ish while
  confidence collapses — the model is telling you it is guessing.
- The billed output is **zero tokens**, because a typed decision is not generated text.

## 6. Media: video, animation, and music (4 min)

**On an unfunded account, show the estimate and the credit notice, then skip to section 7.** The
estimate alone makes the point, and failing honestly is a feature worth thirty seconds.

**Create Video.** Before pressing anything, change the resolution and watch the **estimated cost**
move. This panel can bill several dollars for one click at the top settings, which is why it
estimates before the request rather than only reporting afterwards.

Start a render and then — if you are feeling brave — **close the tab**. Reopen the panel. The job is
still running, because generation happens in a Workflow rather than in the request. Had it run in
the request, closing the tab would have cancelled a render that was already paid for.

When it finishes, **seek in the video**. That works because the bytes were copied once into this
demo's own R2 bucket and are served from an authenticated route; the provider's link is short-lived
and cross-origin, and the browser never contacts it. Mention that the video is deleted 24 hours
after it is stored, by a scheduled job — and that phase 8 deliberately refused to claim any expiry
until something actually enforced one.

**Animate Image** reuses every piece of that: the same bucket, the same job mechanism, the same
ownership scheme. It is a separate panel rather than a tab inside Create Video, which is the
intended lesson — share code, not tabs.

**Generate Music** is where the billing units stop being tokens. One model bills per second of
audio, the other per track plus a separate charge if it writes the lyrics. Show the session meter
with a Chat run and a music run in it together: the units are labelled rather than added up as if
they were comparable.

## 7. Activity and gateway — the payoff (3 min)

Open **Activity and gateway**, then switch to the AI Gateway dashboard tab.

This is where the opening sentence gets paid off. Every run from the last twenty minutes is in that
dashboard: the model, the cost, the cache status, the latency.

Three things to draw out:

- **Each request carries your verified email** in its gateway metadata. In a shared demo account,
  spending is attributable to the person who caused it. The application discloses that before the
  first request rather than burying it.
- **The email is in gateway metadata and nowhere else.** The application's own structured logs carry
  run identifiers, model identifiers, durations and outcomes — never a prompt, never content, never
  the email. Those are different retention domains with different access control.
- **There is exactly one documented exception, and it is the most interesting part.**
  `AI-GATEWAY-EXCEPTIONS.md` records that the Cloudflare-hosted FLUX.2 models in Remix Image cannot
  be gateway-routed: they take a multipart `ReadableStream` body, and the gateway rejects it with
  `AI Gateway does not support ReadableStreams yet.` So the register is not empty — and that is a
  stronger demonstration than if it were. The invariant is enforced by a build check rather than by
  intent, the one genuine platform gap is written down with what observability it costs, and Run
  Details shows those runs as `Not applicable` rather than `$0.00`, because an unmeasurable cost and
  a zero cost are different claims.

  If you have time, open Remix Image with a FLUX.2 model selected and show that Run Details says so
  plainly. A demo that quietly hid its one exception would be making exactly the claim this
  application exists to argue against.

Finish by showing the **session cost meter** total and noting that every figure in it came from a
gateway log rather than from a token count the browser estimated.

---

## Questions you will be asked

**"Is this using my data to train anything?"** This demo cannot answer that for you, and it does not
pretend to. It says: assume your prompt is logged, treat it like any shared AI service, and do not
enter anything confidential. It sends a header asking AI Gateway not to retain payloads, but the
application cannot verify that header took effect, so it makes no promise it cannot keep.

**"Why is everything behind a login?"** Cloudflare Access protects every path, and any identity the
configured provider accepts can sign in — there is no application-level allowlist. The Worker also
validates the Access JWT _and_ the specific audience itself, because every Access application in a
team shares a JWKS: without the audience check, a token minted for an unrelated application in the
same team would be accepted.

**"What happens if a model fails?"** Show it: the panel reports a sanitised message, and the logs
carry the provider's real one under the same run identifier. Both are required. An earlier version
discarded the cause and a deployed `502` became undiagnosable — the fix is the reason the
observability rules exist at all.

**"Could I add a panel?"** Yes, and the tests will tell you what you forgot. A new panel is covered
automatically by the metadata contract, the observability contract, and the accessibility contract,
because all three are driven from the task catalogue rather than from a list someone maintains.

## Afterwards

If you deployed into a scratch account for the demo, `pnpm teardown` removes the Worker and then
destroys the infrastructure, emptying the R2 bucket on the way through. The account should be clean
afterwards; see the README's deployment section for what that ordering protects against.
