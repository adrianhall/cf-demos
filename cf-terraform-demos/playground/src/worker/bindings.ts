import type { CloudflareToolkitVariables } from '@adrianhall/cloudflare-toolkit/hono';
import type { AnimateImageService } from './application/animate-image/animate-image-service';
import type { ChatService } from './application/chat/chat-service';
import type { ClassifyImageService } from './application/classify-image/classify-image-service';
import type { ClassifyTextService } from './application/classify-text/classify-text-service';
import type { CreateImageService } from './application/create-image/create-image-service';
import type { CreateVideoService } from './application/create-video/create-video-service';
import type { DescribeImageService } from './application/describe-image/describe-image-service';
import type { DetectObjectsService } from './application/detect-objects/detect-objects-service';
import type { EvaluateChoicesService } from './application/evaluate-choices/evaluate-choices-service';
import type { GenerateMusicService } from './application/generate-music/generate-music-service';
import type { MetricsService } from './application/metrics/metrics-service';
import type { ReadTextService } from './application/read-text/read-text-service';
import type { RemixImageService } from './application/remix-image/remix-image-service';
import type { SemanticSearchService } from './application/semantic-search/semantic-search-service';
import type { TranscribeAudioService } from './application/transcribe-audio/transcribe-audio-service';
import type { TranslateTextService } from './application/translate-text/translate-text-service';

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
   * The Create Video use case, sharing this request's run store.
   *
   * Unlike the other services it holds no inference client: the gateway call happens inside the
   * Workflow, long after the request that started it has ended.
   */
  CREATE_VIDEO_SERVICE: CreateVideoService;
  /**
   * The Animate Image use case, sharing this request's run store.
   *
   * Like Create Video it holds no inference client, because the gateway call happens inside its
   * Workflow. It also shares Create Video's bucket and job machinery rather than owning its own:
   * the two panels differ in their request and their route, not in how a job is stored or owned.
   */
  ANIMATE_IMAGE_SERVICE: AnimateImageService;
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
   * Detect Objects use case.
   */
  DETECT_OBJECTS_SERVICE: DetectObjectsService;
  /**
   * The Generate Music use case, sharing this request's gateway client and run store, plus the
   * provider-audio retrieval client.
   *
   * Unlike Create Video it holds no job or storage dependency: neither reviewed music model has a
   * job API, so the track arrives within the request and is returned rather than stored.
   */
  GENERATE_MUSIC_SERVICE: GenerateMusicService;
  /**
   * The Read Text use case, sharing this request's gateway client and run store.
   */
  READ_TEXT_SERVICE: ReadTextService;
  /**
   * The Transcribe Audio use case, sharing this request's gateway client and run store.
   */
  TRANSCRIBE_AUDIO_SERVICE: TranscribeAudioService;
  /**
   * The Translate Text use case, sharing this request's gateway client and run store.
   */
  TRANSLATE_TEXT_SERVICE: TranslateTextService;
  /**
   * The Classify Text use case, sharing this request's gateway client and run store.
   */
  CLASSIFY_TEXT_SERVICE: ClassifyTextService;
  /**
   * The Semantic Search use case, sharing this request's gateway client and run store, plus the
   * isolate's embedding cache.
   */
  SEMANTIC_SEARCH_SERVICE: SemanticSearchService;
  /**
   * The Evaluate Choices use case, sharing this request's gateway client and run store.
   */
  EVALUATE_CHOICES_SERVICE: EvaluateChoicesService;
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
