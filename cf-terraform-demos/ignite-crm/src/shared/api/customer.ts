/**
 * @file Customer timeline projections: a contact or company together with its deals, calls and
 *   meetings, next action, and history. These compose the record schemas in `crm.ts` with the sales
 *   schemas in `sales.ts`; they live in their own module so neither of those depends on the other.
 *   Each projection is built by one Data Worker call with a bounded, fixed number of queries —
 *   never one call per related record.
 */

import * as v from 'valibot';
import { CompanySchema, ContactSchema, ContactSummarySchema, HistoryEntrySchema } from './crm.ts';
import { ActivitySchema, ContactNextActionSchema, DealSchema } from './sales.ts';

/**
 * Most deals listed on a contact or company.
 */
export const TIMELINE_DEAL_LIMIT = 50;

/**
 * Most activities listed on a contact, company, or deal.
 */
export const TIMELINE_ACTIVITY_LIMIT = 50;

/**
 * A contact's customer timeline.
 */
export const ContactDetailSchema = v.strictObject({
  /**
   * The contact.
   */
  contact: ContactSchema,
  /**
   * The contact's open next action, if any.
   */
  nextAction: v.nullable(ContactNextActionSchema),
  /**
   * Deals where this contact is the primary contact, newest first.
   */
  deals: v.array(DealSchema),
  /**
   * Calls and meetings linked to this contact, newest first.
   */
  activities: v.array(ActivitySchema),
  /**
   * Most recent history entries, newest first.
   */
  history: v.array(HistoryEntrySchema)
});

/**
 * A contact detail projection.
 */
export type ContactDetail = v.InferOutput<typeof ContactDetailSchema>;

/**
 * A company's customer timeline.
 */
export const CompanyDetailSchema = v.strictObject({
  /**
   * The company.
   */
  company: CompanySchema,
  /**
   * Active contacts at the company (at most 100, by name).
   */
  contacts: v.array(ContactSummarySchema),
  /**
   * Deals filed under the company, newest first.
   */
  deals: v.array(DealSchema),
  /**
   * Calls and meetings linked to the company directly, or to any of its contacts or deals.
   */
  activities: v.array(ActivitySchema),
  /**
   * Most recent history entries, newest first.
   */
  history: v.array(HistoryEntrySchema)
});

/**
 * A company detail projection.
 */
export type CompanyDetail = v.InferOutput<typeof CompanyDetailSchema>;
