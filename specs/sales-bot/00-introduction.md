# SalesBot — an agent for answering sales questions

**Status:** Product introduction; detailed engineering specification follows.

SalesBot is a Cloudflare-native agent that answers Cloudflare sales questions from product
documentation and product-team FAQs. The MVP supports web chat. Email and Google Chat are planned
post-MVP channels that will use the same conversation, retrieval, answer, and escalation workflow.

When documentation and approved FAQs are insufficient, stale, restricted, or the salesperson asks for
a better answer, SalesBot escalates to the appropriate product manager. The PM receives the transcript
and evidence available to the requester, responds through the original channel, and may publish the
answer as a new FAQ. FAQs can have an expiry date and an audience classification: internal, under NDA,
customer, or public.

## Product roles

- **Salesperson:** asks questions, requests escalation, and receives answers through an approved
  channel.
- **Product manager:** manages owned FAQs, answers assigned escalations, closes or reassigns them, and
  optionally publishes answers as FAQs.
- **Manager/overseer:** views escalation and response-time dashboards for products in their scope.
- **Administrator:** manages the product/PM map, all FAQs, and the escalation queue.

The application must enforce authorization server-side. Cloudflare Access authenticates web users;
application roles and product scope determine what they may do. Channel claims supplied by a user in a
message must never be treated as identity.

## MVP channels and permissions

1. **Web chat:** requires a valid Cloudflare Access session and an approved identity. The user can
   start a session, ask questions, request escalation, and view their own transcript.
2. **Management console:** requires Cloudflare Access plus PM, overseer, or administrator
   authorization. It provides the PM queue, FAQ management, map administration, dashboards, and the
   test interface.

A responsive web interface is mandatory. It is both the management console and the complete
end-to-end test client for the MVP. The test interface must use the same application use cases as the
production web chat and must not weaken production authorization.

## Post-MVP channel extensions

Email and Google Chat begin only after MVP hardening is complete. Their adapters must use the already
proven conversation and delivery ports; they must not duplicate the agent, retrieval, escalation, or
FAQ workflow.

- **Email:** will use Cloudflare Email Routing for ingress and Cloudflare Email Sending for replies.
  Only approved sender domains will be accepted after configured SPF/DKIM/DMARC and sender-domain
  checks. Email remains a question/answer channel, never a management interface.
- **Google Chat:** will require authenticated webhook events, an allowlisted space or direct message,
  and a verified Google identity mapped to an approved user or domain. It will reply only to the
  verified thread and will not process unrelated messages.

## Cloudflare platform constraint

Use only the Cloudflare Developer Platform for compute, storage, AI, retrieval, authentication,
queues, scheduling, and observability. The MVP uses Workers, Durable Objects, D1, Queues, AI Search,
AI Gateway, Workers AI, and Access. The post-MVP email extension adds Cloudflare DNS, Email Routing,
and Email Sending. Google Chat is an external protocol at the edge; it must not introduce an external
application server or database.

## Demo data

The initial documentation source is the Cloudflare docs checkout at
`~/repos/cloudflare/cloudflare-docs`. Seed the following product ownership map:

```csv
Product,Product Manager,Escalation
Basin,Mark Selwan,Rita Koslov
Stream,Taylor Smith,Rita Koslov
Images,Deanna Lam,Rita Koslov
Realtime Kit,Korinne Alpers,Rita Koslov
Workers AI,Michelle Chen,Rita Koslov
AI Gateway,Ming Lu,Michelle Chen
AI Search,Anni Wang,Michelle Chen
Browser Run,Kathy Liao,Rita Koslov
Agents,Thomas Gauvin,Rita Koslov
Email,Thomas Gauvin,Rita Koslov
Gadgets,Phillip Jones,Rita Koslov
Durable Objects,Brendon Iglesias,Brendan Irvine-Broque
D1,Ivory Ibuaka,Vy Ton
KV,Ivory Ibuaka,Vy Ton
Hyperdrive,Ivory Ibuaka,Vy Ton
Workers for Platforms,Dina Koslov,Brendan Irvine-Broque
```

Unlisted products default to Rita Koslov. A PM can reassign an escalation to another PM, but an
escalation may never be assigned back to anyone who previously reassigned that same escalation. This
prevents circular escalation and must be enforced by the application, not only by the UI.

See [`01-specification.md`](./01-specification.md) for the engineering contract and
[`02-implementation.md`](./02-implementation.md) for the phased delivery plan.
