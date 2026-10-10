import { badRequest, notFound } from "@adrianhall/cloudflare-toolkit/errors";
import { Hono } from "hono";
import type { AppBindings } from "../bindings";
import { ChannelRepository } from "../channels/repository";
import { validateChannelName } from "../channels/validation";

/** Authenticated WebSocket upgrade API mounted at `/api/channels`. */
export const roomsRouter = new Hono<AppBindings>();

/** Forward an authenticated upgrade to the Durable Object named by the validated channel. */
roomsRouter.get("/:channel/ws", async (context) => {
  const channel = validateChannelName(context.req.param("channel"));
  if (context.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    throw badRequest({ detail: "Expected a WebSocket upgrade request." });
  }

  const repository = new ChannelRepository(context.env.DB);
  if (!(await repository.exists(channel))) {
    throw notFound({ detail: "Channel not found." });
  }

  const headers = new Headers(context.req.raw.headers);
  headers.delete("X-Chat-Identity");
  headers.delete("X-Chat-Channel");
  headers.set(
    "X-Chat-Identity",
    context.get("Cloudflare_Access_Identity").email,
  );
  headers.set("X-Chat-Channel", channel);
  context.get("LOGGER").info("channel_joined", { channel });
  return context.env.CHAT_ROOM.getByName(channel).fetch(
    new Request(context.req.raw, { headers }),
  );
});
