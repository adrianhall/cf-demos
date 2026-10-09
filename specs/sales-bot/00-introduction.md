# SalesBot - an agent for answering sales questions

This demo will demonstrate how to hook in multiple channels to a single agent.  The agent is designed
to answer questions from sales personnel based on available documentation and FAQs filled in by the 
product teams.  If the question cannot be answered by the available documentation and FAQs OR the sales
person wants to escalate for "a better answer", then the escalation is directed to the right person
who, when logging onto the system, gets a transcript of the bot answer and the ability to respond and
mark the response as a new "FAQ".  The bot will then add the FAQ (if so marked) into the knowledge base
and respond to the sales person with the new information via the same channel that they originally used.

Each product has a primary product manager and a set of escalating product managers (their managers,
all the way up to the VP of Product).  The managers will also want to see dashboards showing the number
of escalations and the time to respond to those escalations for the products they oversee.

FAQs should optionally have an "expiry date" - this is the date the PM expects the information to become
stale.  By default, all FAQs have an expiry date of 90 days in the future, but this can be adjusted or
removed by the PM when they answer the question.  In addition, the PM should be able to mark an FAQ as
"internal only", "under NDA only", "customer only", or "public".

Product managers should be able to:

- Manage (create, edit, or delete) their own FAQs.
- View their escalation queue and act on any escalation, including closing an escalation (which responds back to the user that the escalation has been rejected).

Administrators should be able to:

- Edit the "product to product manager" map.
- Manage (create, edit, or delete) any FAQ
- Manage the escalation queue (for example, re-assigning an escalation to another PM).

For the first release, we will support:

1. Web chat (the user logs on to a web interface, starts a session, and asks)
2. Email (use the email routing capabilities in Cloudflare to ask). Emails are only allowed from a specific set of domains and if the domain is validated (typical anti-spam capabilities like SPF and DMARC can be used).
3. GChat (invite the bot to a channel and ask question - responses as replies to the chat)

Expected services:

- Cloudflare Access (authentication)
- Workers (chat, email, gchat, backend processing, site crawler, admin pages)
- Durable Objects (for chat termination and agentic loop)
- AI Gateway (cost controls, coordinated access and centralized logging for AI usage)
- Workers AI (clef-flash for decisions, glm-5.3 for chat)
- AI Search (for the markdown documentation and FAQ search to implement RAG)
- D1 (for the FAQs, escalation map, and the escalations)
