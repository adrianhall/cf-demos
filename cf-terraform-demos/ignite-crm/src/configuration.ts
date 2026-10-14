/**
 * @file The installation configuration: the single non-secret settings object for one deployment.
 *   An installation of Ignite CRM serves one business, so currency, region, and display settings
 *   are installation-wide rather than per-user. Replace {@link DEFAULT_CONFIGURATION} at
 *   installation time to localise a deployment. Secrets, Access audiences, account IDs, and tokens
 *   never belong here — they are bindings populated from Terraform outputs. The value is validated
 *   with Valibot when this module is first imported (Worker start-up), so a malformed edit fails
 *   the first request loudly rather than mis-formatting money in production. Server modules import
 *   it directly; the SPA receives only {@link toDisplayConfiguration}'s DTO.
 */

import * as v from 'valibot';
import {
  type DisplayConfiguration,
  DisplayConfigurationSchema
} from './shared/api/configuration.ts';

/**
 * How long a chat session survives after its last message before it is deleted. Three hours covers
 * a working session with interruptions while keeping transcripts short-lived. Changing the policy
 * is this one line, because the agent reads it rather than restating the number
 * (`specs/ignite-crm/05-ai-features.md` §3.6).
 */
export const CHAT_SESSION_TTL_SECONDS = 3 * 60 * 60;

/**
 * How long, in hours, {@link CHAT_SESSION_TTL_SECONDS} is — for the one user-facing sentence that
 * has to quote it ("This conversation expired after 3 hours of inactivity"), so the notice cannot
 * contradict the policy.
 */
export const CHAT_SESSION_TTL_HOURS = CHAT_SESSION_TTL_SECONDS / 3600;

/**
 * Maximum number of chat messages one session keeps in its own storage. Bounds transcript growth;
 * what is actually sent to the model is bounded separately, per turn, by `pruneMessages`.
 */
export const CHAT_MAX_PERSISTED_MESSAGES = 100;

/**
 * How many model/tool rounds one chat turn may take before it must answer. Bounds both latency and
 * token spend for a confused multi-step plan.
 */
export const CHAT_TOOL_ROUNDS_PER_TURN = 8;

/**
 * Fallback chat model, used when the `AI_CHAT_MODEL` binding is absent. The binding is the real
 * setting, so changing models in a deployment is a configuration edit rather than a code change.
 */
export const DEFAULT_AI_CHAT_MODEL = '@cf/zai-org/glm-4.7-flash';

/**
 * Schema for the installation configuration. Every field is currently browser-safe, so it is the
 * display schema; a future server-only setting would extend this schema without widening the DTO.
 */
export const InstallationConfigurationSchema = DisplayConfigurationSchema;

/**
 * The installation configuration.
 */
export type InstallationConfiguration = Readonly<DisplayConfiguration>;

/**
 * The reviewed UK-oriented default for the first release (specification §9).
 */
export const DEFAULT_CONFIGURATION: InstallationConfiguration = {
  region: 'GB',
  locale: 'en-GB',
  timezone: 'Europe/London',
  currencyCode: 'GBP',
  currencySymbol: '£',
  dateFormat: 'medium',
  numberFormat: 'en-GB',
  weekStartsOn: 1
};

/**
 * Validate a candidate installation configuration.
 *
 * @param candidate The configuration to validate.
 * @returns The validated configuration.
 * @throws {v.ValiError} When any field is missing or invalid, naming the offending path.
 */
export function loadConfiguration(candidate: unknown): InstallationConfiguration {
  return v.parse(InstallationConfigurationSchema, candidate);
}

/**
 * The validated configuration used by this installation.
 */
export const configuration: InstallationConfiguration = loadConfiguration(DEFAULT_CONFIGURATION);

/**
 * Project the configuration onto the browser-safe display DTO.
 *
 * @param config The configuration to project.
 * @returns A fresh DTO containing only fields the SPA may see.
 */
export function toDisplayConfiguration(config: InstallationConfiguration): DisplayConfiguration {
  return {
    region: config.region,
    locale: config.locale,
    timezone: config.timezone,
    currencyCode: config.currencyCode,
    currencySymbol: config.currencySymbol,
    dateFormat: config.dateFormat,
    numberFormat: config.numberFormat,
    weekStartsOn: config.weekStartsOn
  };
}
