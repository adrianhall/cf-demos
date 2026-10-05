import type { ResultControlApplication } from './classify-image.ts';
import type { VerifiedImageFacts } from './describe-image.ts';
import type { RunReceipt } from './runs.ts';

/**
 * Longest target phrase this demo accepts.
 *
 * The model declares no limit of its own, but the target is visitor-supplied free text that is
 * forwarded to a provider and billed as input tokens, so an unbounded field would be both a cost
 * and a payload hazard. A detection target is a noun phrase — "person wearing a red shirt" is 27
 * characters — so a generous ceiling still refuses an essay pasted into the wrong box. This is this
 * demo's limit rather than the provider's, and the refusal message says so.
 */
export const MAX_DETECTION_TARGET_LENGTH = 200;

/**
 * A numeric range declared by the detection model.
 */
export interface DetectionNumericRange {
  /**
   * Inclusive minimum.
   */ min: number;
  /**
   * Inclusive maximum.
   */ max: number;
  /**
   * UI increment.
   */ step: number;
  /**
   * Model default.
   */ default: number;
}
/**
 * The reviewed controls for an object-localisation model.
 */
export interface DetectionControlSupport {
  /**
   * The model receives this natural-language phrase.
   */ target: { required: true };
  /**
   * Maximum regions the provider itself returns.
   */ maxObjects: DetectionNumericRange;
  /**
   * Makes the provider-side limit explicit.
   */ appliedBy: ResultControlApplication;
  /**
   * This model returns no confidence scores; a score floor must never be invented.
   */ scoreFloor: false;
}
/**
 * Browser request for object localisation.
 */
export interface DetectObjectsRequest {
  /**
   * Byte-authoritative base64 image.
   */ imageBase64: string;
  /**
   * Reviewed model identifier.
   */ model: string;
  /**
   * Browser-generated correlation identifier.
   */ runId: string;
  /**
   * Phrase to locate.
   */ target: string;
  /**
   * Provider-side output limit.
   */ maxObjects?: number;
}
/**
 * One validated normalised bounding box, in fractions of the source dimensions.
 */
export interface Detection {
  /**
   * Stable response position.
   */ index: number;
  /**
   * Caller-supplied target, not a model label.
   */ label: string;
  /**
   * Left edge fraction.
   */ xMin: number;
  /**
   * Top edge fraction.
   */ yMin: number;
  /**
   * Right edge fraction.
   */ xMax: number;
  /**
   * Bottom edge fraction.
   */ yMax: number;
  /**
   * Human-readable region derived from geometry.
   */ region: string;
}
/**
 * Actual controls used for a localisation run.
 */
export interface AppliedDetectionControls {
  /**
   * Model identifier.
   */ model: string;
  /**
   * Target supplied to the model.
   */ target: string;
  /**
   * Limit applied by the model.
   */ maxObjects: number;
}
/**
 * Successful detection response.
 */
export interface DetectObjectsResponse {
  /**
   * Regions in provider order, without an invented rank or score.
   */ detections: Detection[];
  /**
   * Byte-verified source facts.
   */ image: VerifiedImageFacts;
  /**
   * Gateway run receipt.
   */ receipt: RunReceipt;
  /**
   * Actual model parameters.
   */ applied: AppliedDetectionControls;
}
