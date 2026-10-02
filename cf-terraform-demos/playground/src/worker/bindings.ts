import type { CloudflareToolkitVariables } from '@adrianhall/cloudflare-toolkit/hono';
import type { ChatService } from './application/chat/chat-service';
import type { ClassifyImageService } from './application/classify-image/classify-image-service';
import type { CreateImageService } from './application/create-image/create-image-service';
import type { DescribeImageService } from './application/describe-image/describe-image-service';
import type { MetricsService } from './application/metrics/metrics-service';
import type { RemixImageService } from './application/remix-image/remix-image-service';

/**
 * Hono context variables added by this Worker: the toolkit's `Cloudflare_Access_Identity` and
 * `LOGGER`, plus the request-scoped application services.
 *
 * The services are declared here and set by the composition root's middleware, so a route handler
 * receives them ready-made. That is what keeps `routes/` thin: a handler reads a service off the
 * context, and there is no constructor call it could reach for instead.
 */
export interface AppVariables extends CloudflareToolkitVariables {
  /**
   * The Chat use case, bound to this request's gateway client and run store.
   */
  CHAT_SERVICE: ChatService;
  /**
   * The Create Image use case, sharing this request's gateway client and run store.
   */
  CREATE_IMAGE_SERVICE: CreateImageService;
  /**
   * The Describe Image use case, sharing this request's gateway client and run store.
   */
  DESCRIBE_IMAGE_SERVICE: DescribeImageService;
  /**
   * The Remix Image use case, sharing this request's gateway client and run store.
   */
  REMIX_IMAGE_SERVICE: RemixImageService;
  /**
   * The Classify Image use case, sharing this request's gateway client and run store.
   */
  CLASSIFY_IMAGE_SERVICE: ClassifyImageService;
  /**
   * The run-metrics use case, sharing this request's gateway client and run store.
   */
  METRICS_SERVICE: MetricsService;
}

/**
 * Hono environment shape shared by the top-level app and every sub-router/middleware in this
 * Worker, so `new Hono<AppBindings>()` is the single source of truth for `c.env` and
 * `c.get`/`c.set` typing across `src/worker`.
 */
export interface AppBindings {
  /**
   * Worker bindings generated from `cloudflare.config.ts` by `cf workers types`.
   *
   * `ENVIRONMENT` intentionally does not exist in local development: its absence selects the
   * toolkit's development logging defaults without needing an untracked `.dev.vars` file.
   * Production binds it explicitly as `"production"`.
   */
  Bindings: Env & { ENVIRONMENT?: string };
  /**
   * Request-scoped application values set by this Worker's middleware.
   */
  Variables: AppVariables;
}
