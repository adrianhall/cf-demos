/**
 * @file Mounts a route under test with stubbed context variables. The routers are mounted without
 *   the Access middleware: authentication is covered against the real Worker in the Workers-runtime
 *   suite, and these tests exist to pin each route's own behaviour. A failure here therefore points
 *   at the handler rather than at the middleware stack.
 */

import { Hono } from 'hono';
import type { CloudflareAccessIdentity } from '@adrianhall/cloudflare-toolkit/hono';
import type { Logger } from '@adrianhall/cloudflare-toolkit/logging';
import type { ChatService } from '../../../src/worker/application/chat/chat-service';
import type { CreateImageService } from '../../../src/worker/application/create-image/create-image-service';
import type { MetricsService } from '../../../src/worker/application/metrics/metrics-service';
import type { AppBindings } from '../../../src/worker/bindings';

/**
 * Records every structured log a route emitted, so a test can assert on what was _not_ logged.
 *
 * That negative assertion is the important one: the demo promises that prompts, answers, and the
 * verified email never reach Worker logs, and the only way to keep that promise is to check it.
 */
export interface LogCapture {
  /**
   * Every log call, in order.
   */
  entries: { level: string; message: string; context?: Record<string, unknown> }[];
  /**
   * Every captured entry serialised as one string, for "must not contain" assertions.
   *
   * @returns The concatenated JSON of every entry.
   */
  text: () => string;
}

/**
 * Options for {@link mountRoute}.
 */
export interface MountOptions {
  /**
   * Verified identity to place on the context, as the Access middleware would.
   */
  identity?: Pick<CloudflareAccessIdentity, 'email' | 'sub'> | undefined;
  /**
   * Chat service the route should use.
   */
  chatService?: ChatService;
  /**
   * Metrics service the route should use.
   */
  metricsService?: MetricsService;
  /**
   * Create Image service the route should use.
   */
  createImageService?: CreateImageService;
}

/**
 * Creates a capturing logger.
 *
 * @returns The capture and a `Logger` that writes into it.
 */
export function createLogCapture(): { capture: LogCapture; logger: Logger } {
  const entries: LogCapture['entries'] = [];

  /**
   * Builds one level's log method.
   *
   * @param level Level being recorded.
   * @returns A function that appends to the capture.
   */
  const record =
    (level: string) =>
    (message: string, context?: Record<string, unknown>): void => {
      entries.push(context === undefined ? { level, message } : { level, message, context });
    };

  const logger = {
    trace: record('trace'),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    fatal: record('fatal'),
    child: () => logger
  } as unknown as Logger;

  return {
    capture: { entries, text: () => JSON.stringify(entries) },
    logger
  };
}

/**
 * Mounts one router with stubbed context variables.
 *
 * @param path Path prefix to mount the router at, matching the composition root.
 * @param router The router under test.
 * @param options Identity and services to place on the context; see {@link MountOptions}.
 * @returns The app to dispatch requests through, and the captured logs.
 */
export function mountRoute(
  path: string,
  router: Hono<AppBindings>,
  options: MountOptions = {}
): { app: Hono<AppBindings>; logs: LogCapture } {
  const { capture, logger } = createLogCapture();
  // Typed with the application's own bindings, so `context.set` is checked against the real
  // `AppVariables` rather than silently accepting any key a test invents.
  const app = new Hono<AppBindings>();

  app.use(async (context, next) => {
    context.set('LOGGER', logger);
    if (options.identity !== undefined) {
      // The Access middleware normally sets this from a verified JWT. A test supplies only the
      // claims the routes read, so the fixture is cast to the full identity shape.
      context.set(
        'Cloudflare_Access_Identity',
        options.identity as unknown as CloudflareAccessIdentity
      );
    }
    if (options.chatService !== undefined) {
      context.set('CHAT_SERVICE', options.chatService);
    }
    if (options.metricsService !== undefined) {
      context.set('METRICS_SERVICE', options.metricsService);
    }
    if (options.createImageService !== undefined) {
      context.set('CREATE_IMAGE_SERVICE', options.createImageService);
    }
    await next();
  });

  app.route(path, router);

  return { app, logs: capture };
}
