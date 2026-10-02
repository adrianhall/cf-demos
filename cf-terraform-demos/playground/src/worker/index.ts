import { Hono } from 'hono';
import {
  cloudflareLogger,
  notFoundHandler,
  problemDetailsErrorHandler
} from '@adrianhall/cloudflare-toolkit/hono';
import { createMeRouter } from '@demos/worker-common';
import { ChatService } from './application/chat/chat-service';
import { ClassifyImageService } from './application/classify-image/classify-image-service';
import { CreateImageService } from './application/create-image/create-image-service';
import { CreateVideoService } from './application/create-video/create-video-service';
import { DescribeImageService } from './application/describe-image/describe-image-service';
import { MetricsService } from './application/metrics/metrics-service';
import { RemixImageService } from './application/remix-image/remix-image-service';
import type { AppBindings } from './bindings';
import { GatewayInferenceClient } from './infrastructure/ai/gateway-inference-client';
import { WorkflowMediaJobs } from './infrastructure/jobs/workflow-media-jobs';
import { ProviderImageClient } from './infrastructure/media/provider-image-client';
import { R2VideoStorage } from './infrastructure/media/r2-video-storage';
import { createMemoryRunRepository } from './infrastructure/runs/memory-run-repository';
import { accessMiddleware } from './middleware/access';
import { catalogueRouter } from './routes/catalogue';
import { chatRouter } from './routes/chat';
import { classifyImageRouter } from './routes/classify-image';
import { createImageRouter } from './routes/create-image';
import { createVideoRouter } from './routes/create-video';
import { describeImageRouter } from './routes/describe-image';
import { remixImageRouter } from './routes/remix-image';
import { runsRouter } from './routes/runs';

/**
 * Worker entry point and composition root.
 *
 * This file is allowed to depend on every server-side tier — routes, middleware, application,
 * domain, and infrastructure — because composing them is its single responsibility. No other module
 * gets that privilege: a route handler that constructs an inference client would be reaching across
 * the boundary this file exists to hold.
 *
 * Only `/api/*` reaches this Worker in production; every other path is served directly by the
 * `ASSETS` binding with a single-page-application fallback (see `cloudflare.config.ts`). The Access
 * middleware is nonetheless mounted for _all_ paths rather than just `/api/*`, so a request that
 * does arrive here — in local development, in the Workers-runtime test suite, or if asset routing
 * ever changed — is authenticated rather than served by accident.
 */
const app = new Hono<AppBindings>();

app.use(cloudflareLogger());
app.use(accessMiddleware);

/**
 * Builds the request-scoped application services and puts them on the context.
 *
 * Construction is per request because the gateway client closes over `c.env`, which is only
 * available inside a request. The run repository's storage is module-scoped, so a record written by
 * one request is still readable by the next within the same isolate — which is what makes a
 * follow-up metrics lookup possible at all.
 *
 * Mounted after the Access middleware so it never runs for an unauthenticated request: there is no
 * point constructing an inference client for a caller who is about to receive a `401`.
 */
app.use('/api/*', async (context, next) => {
  const inference = new GatewayInferenceClient({
    ai: context.env.AI,
    gatewayId: context.env.AI_GATEWAY_ID,
    // The request-scoped logger, so a provider failure is recorded with the same request identifier
    // as every other line from this request. The client logs the provider's real message and
    // returns a sanitised one to the browser; both are required, and neither substitutes for the
    // other.
    logger: context.var.LOGGER
  });
  const runs = createMemoryRunRepository();
  const media = new ProviderImageClient();

  context.set('CHAT_SERVICE', new ChatService({ inference, runs }));
  context.set(
    'CREATE_IMAGE_SERVICE',
    new CreateImageService({ inference, runs, logger: context.var.LOGGER })
  );
  context.set(
    'CREATE_VIDEO_SERVICE',
    new CreateVideoService({
      jobs: new WorkflowMediaJobs(context.env.VIDEO_JOBS),
      storage: new R2VideoStorage(context.env.VIDEO_BUCKET),
      runs,
      // The Access audience tag keys the job-identifier derivation. It is already bound, already
      // has to be correct for anything to work, and is not visible to a visitor — see
      // `domain/media-job-identity.ts` for why a keyed derivation rather than a plain hash.
      jobIdKey: context.env.ACCESS_AUD,
      logger: context.var.LOGGER
    })
  );
  context.set(
    'DESCRIBE_IMAGE_SERVICE',
    new DescribeImageService({ inference, runs, logger: context.var.LOGGER })
  );
  context.set(
    'REMIX_IMAGE_SERVICE',
    new RemixImageService({ inference, runs, media, logger: context.var.LOGGER })
  );
  context.set(
    'CLASSIFY_IMAGE_SERVICE',
    new ClassifyImageService({ inference, runs, logger: context.var.LOGGER })
  );
  context.set('METRICS_SERVICE', new MetricsService({ inference, runs }));

  await next();
});

app.route('/api/me', createMeRouter<AppBindings>());
app.route('/api/catalogue', catalogueRouter);
app.route('/api/chat', chatRouter);
app.route('/api/classify-image', classifyImageRouter);
app.route('/api/create-image', createImageRouter);
app.route('/api/create-video', createVideoRouter);
app.route('/api/describe-image', describeImageRouter);
app.route('/api/remix-image', remixImageRouter);
app.route('/api/runs', runsRouter);

// `includeStack` is gated on `import.meta.env.DEV`, which Vite replaces with the literal `false` in
// a production build, so a deployed Worker can never emit a stack trace to a client.
app.onError(problemDetailsErrorHandler({ includeStack: import.meta.env.DEV }));
app.notFound(notFoundHandler());

export default app;

// The Workflow class is exported from the Worker's entry module because `cloudflare.config.ts`
// declares it as a named export of this Worker. It is deliberately the only export besides the app
// itself: everything else reaches the platform through a binding.
export { CreateVideoWorkflow } from './infrastructure/jobs/create-video-workflow';
