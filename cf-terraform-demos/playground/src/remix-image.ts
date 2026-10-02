/**
 * @file Shared contracts for editing one image with a reviewed reference-image model.
 */
import type { VerifiedImageFacts } from './describe-image.ts';
import type { GeneratedImage } from './images.ts';
import type { RunReceipt } from './runs.ts';

/**
 * Longest editing instruction accepted.
 */
export const MAX_REMIX_INSTRUCTION_CHARACTERS = 2_048;

/**
 * Model-specific request adapter used by the Worker.
 */
export type RemixImageInputAdapter = 'flux-multipart' | 'pruna-json' | 'nano-banana-json';

/**
 * Controls and wire contract one reviewed reference-image model explicitly supports.
 */
export interface RemixImageControlSupport {
  /**
   * Whether a reproducible random seed is accepted.
   */
  seed: boolean;
  /**
   * Explicit request builder for this reviewed provider schema.
   */
  inputAdapter: RemixImageInputAdapter;
  /**
   * Longest source-image edge accepted, when the provider declares one.
   */
  maxInputEdge?: number;
  /**
   * HTTPS hosts from which this model may return short-lived generated media.
   */
  outputHosts: readonly string[];
}

/**
 * Browser request for one reference-image edit.
 */
export interface RemixImageRequest {
  /**
   * Base64 source image, whose format and dimensions the server re-verifies.
   */
  imageBase64: string;
  /**
   * Reviewed reference-image model identifier.
   */
  model: string;
  /**
   * Opaque browser-generated run identifier.
   */
  runId: string;
  /**
   * Required instruction describing the edit while naming what should be preserved.
   */
  instruction: string;
  /**
   * Optional reproducibility seed.
   */
  seed?: number;
}

/**
 * Controls actually used for one edit.
 */
export interface AppliedRemixImageControls {
  /**
   * Model that produced the output.
   */
  model: string;
  /**
   * Trimmed editing instruction.
   */
  instruction: string;
  /**
   * Applied seed, when supplied.
   */
  seed?: number;
}

/**
 * Successful Remix Image response.
 */
export interface RemixImageResponse {
  /**
   * Server-fetched and byte-sniffed transformed image.
   */
  image: GeneratedImage;
  /**
   * Facts verified from the source bytes before inference.
   */
  source: VerifiedImageFacts;
  /**
   * Gateway-backed run receipt.
   */
  receipt: RunReceipt;
  /**
   * Controls actually applied.
   */
  applied: AppliedRemixImageControls;
}
