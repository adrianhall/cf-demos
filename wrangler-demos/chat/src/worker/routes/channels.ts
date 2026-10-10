import { badRequest, notFound } from "@adrianhall/cloudflare-toolkit/errors";
import { Hono } from "hono";
import type { AppBindings } from "../bindings";
import { ChannelRepository } from "../channels/repository";
import {
  validateChannelName,
  validateCreateChannelInput,
} from "../channels/validation";

/** Authenticated identity and shared D1 channel-directory API mounted at `/api`. */
export const channelsRouter = new Hono<AppBindings>();

/** Parse JSON bodies while preserving RFC 9457 responses for malformed input. */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw badRequest({ detail: "Request body must contain valid JSON." });
  }
}

/** Return the verified identity used to label authored messages in the browser. */
channelsRouter.get("/me", (context) => {
  return context.json({
    email: context.get("Cloudflare_Access_Identity").email,
  });
});

/** List the shared, D1-backed channel directory. */
channelsRouter.get("/channels", async (context) => {
  const repository = new ChannelRepository(context.env.DB);
  return context.json({ channels: await repository.list() });
});

/** Add one normalized channel for every authenticated participant. */
channelsRouter.post("/channels", async (context) => {
  const input = validateCreateChannelInput(await readJson(context.req.raw));
  const identity = context.get("Cloudflare_Access_Identity").email;
  const repository = new ChannelRepository(context.env.DB);
  const channel = await repository.create(input.name, identity);
  context.get("LOGGER").info("channel_created", { channel: channel.name });
  return context.json({ channel }, 201);
});

/** Remove a channel's Durable Object state before deleting its D1 directory entry. */
channelsRouter.delete("/channels/:channel", async (context) => {
  const name = validateChannelName(context.req.param("channel"));
  const repository = new ChannelRepository(context.env.DB);
  if (!(await repository.exists(name))) {
    throw notFound({ detail: "Channel not found." });
  }

  await context.env.CHAT_ROOM.getByName(name).destroy();
  await repository.remove(name);
  context.get("LOGGER").info("channel_removed", { channel: name });
  return new Response(null, { status: 204 });
});
