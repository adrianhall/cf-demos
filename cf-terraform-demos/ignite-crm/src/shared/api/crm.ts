/**
 * @file Companies and contacts: SPA ↔ API wire schemas. These same values cross the Data Worker RPC
 *   boundary unchanged, so one schema set governs the browser contract, the Application Worker's
 *   output validation, and the Data Worker's input validation. Every request schema is a
 *   `strictObject`, so an unexpected member — notably an attempt to supply an `ownerId` or
 *   `createdBy` — is rejected rather than silently ignored.
 */

import * as v from 'valibot';
import { TimestampSchema } from '../common/dates.ts';
import { IdSchema } from '../common/ids.ts';
import { CursorSchema, MAX_PAGE_SIZE, pageSchema } from '../common/paging.ts';
import {
  OptionalEmailSchema,
  OptionalHttpsUrlSchema,
  optionalText,
  requiredText,
  SearchTermSchema
} from '../validation/fields.ts';

/**
 * A reference to a user, as shown beside records they own or created.
 */
export const UserRefSchema = v.strictObject({
  /**
   * User identifier.
   */
  id: IdSchema,
  /**
   * Display name.
   */
  displayName: v.string()
});

/**
 * A user reference.
 */
export type UserRef = v.InferOutput<typeof UserRefSchema>;

/**
 * Schema for a UK Companies House company page link. Only the official service host is accepted,
 * which keeps the field meaningful and stops it being used as an arbitrary outbound link.
 */
export const CompaniesHouseUrlSchema = v.optional(
  v.nullable(
    v.pipe(
      OptionalHttpsUrlSchema,
      v.check(
        (value) =>
          value === null
          || value === undefined
          || value.startsWith(
            'https://find-and-update.company-information.service.gov.uk/company/'
          ),
        'Must be a find-and-update.company-information.service.gov.uk company link.'
      )
    )
  ),
  null
);

/**
 * Schema for an optional stock ticker symbol (upper-cased, e.g. `LSE:VOD`).
 */
export const StockSymbolSchema = v.optional(
  v.nullable(
    v.pipe(
      v.string(),
      v.trim(),
      v.toUpperCase(),
      v.transform((value) => (value === '' ? null : value)),
      v.nullable(
        v.pipe(
          v.string(),
          v.maxLength(16, 'Stock symbol must be at most 16 characters.'),
          v.regex(/^[A-Z0-9.:-]+$/u, 'Stock symbol may contain letters, digits, ".", ":" and "-".')
        )
      )
    )
  ),
  null
);

/**
 * A company summary, as shown in lists.
 */
export const CompanySummarySchema = v.strictObject({
  /**
   * Company identifier.
   */
  id: IdSchema,
  /**
   * Company name.
   */
  name: v.string(),
  /**
   * Number of active contacts at the company.
   */
  contactCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /**
   * Last modification instant.
   */
  updatedAt: TimestampSchema
});

/**
 * A company summary.
 */
export type CompanySummary = v.InferOutput<typeof CompanySummarySchema>;

/**
 * A contact summary, as shown in lists and on a company.
 */
export const ContactSummarySchema = v.strictObject({
  /**
   * Contact identifier.
   */
  id: IdSchema,
  /**
   * Name shown for the contact: their name, or their company when they have none.
   */
  displayName: v.string(),
  /**
   * E-mail address, if recorded.
   */
  email: v.nullable(v.string()),
  /**
   * Job title, if recorded.
   */
  jobTitle: v.nullable(v.string()),
  /**
   * Company identifier, if the contact belongs to one.
   */
  companyId: v.nullable(IdSchema),
  /**
   * Company name, if the contact belongs to one.
   */
  companyName: v.nullable(v.string()),
  /**
   * Last modification instant.
   */
  updatedAt: TimestampSchema
});

/**
 * A contact summary.
 */
export type ContactSummary = v.InferOutput<typeof ContactSummarySchema>;

/**
 * One entry in a record's change history.
 */
export const HistoryEntrySchema = v.strictObject({
  /**
   * Audit event identifier.
   */
  id: IdSchema,
  /**
   * What happened, e.g. `created`.
   */
  action: v.string(),
  /**
   * Who did it.
   */
  actor: UserRefSchema,
  /**
   * When it happened.
   */
  occurredAt: TimestampSchema
});

/**
 * A history entry.
 */
export type HistoryEntry = v.InferOutput<typeof HistoryEntrySchema>;

/**
 * A full company record.
 */
export const CompanySchema = v.strictObject({
  /**
   * Company identifier.
   */
  id: IdSchema,
  /**
   * Company name.
   */
  name: v.string(),
  /**
   * Business address as free text (multi-line).
   */
  address: v.nullable(v.string()),
  /**
   * Stock ticker symbol, if listed.
   */
  stockSymbol: v.nullable(v.string()),
  /**
   * Companies House registration link, if UK-registered.
   */
  companiesHouseUrl: v.nullable(v.string()),
  /**
   * The company's primary contact, if any.
   */
  primaryContact: v.nullable(v.strictObject({ id: IdSchema, displayName: v.string() })),
  /**
   * Optimistic-concurrency version.
   */
  version: v.pipe(v.number(), v.integer(), v.minValue(1)),
  /**
   * Creation instant.
   */
  createdAt: TimestampSchema,
  /**
   * Last modification instant.
   */
  updatedAt: TimestampSchema
});

/**
 * A company.
 */
export type Company = v.InferOutput<typeof CompanySchema>;

/**
 * A company with its contacts and recent history.
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
   * Most recent history entries, newest first.
   */
  history: v.array(HistoryEntrySchema)
});

/**
 * A company detail projection.
 */
export type CompanyDetail = v.InferOutput<typeof CompanyDetailSchema>;

/**
 * A full contact record.
 */
export const ContactSchema = v.strictObject({
  /**
   * Contact identifier.
   */
  id: IdSchema,
  /**
   * Given name, if recorded.
   */
  firstName: v.nullable(v.string()),
  /**
   * Family name, if recorded.
   */
  lastName: v.nullable(v.string()),
  /**
   * Name shown for the contact.
   */
  displayName: v.string(),
  /**
   * E-mail address, if recorded.
   */
  email: v.nullable(v.string()),
  /**
   * Telephone number, if recorded.
   */
  phone: v.nullable(v.string()),
  /**
   * Job title, if recorded.
   */
  jobTitle: v.nullable(v.string()),
  /**
   * The contact's company, if any.
   */
  company: v.nullable(v.strictObject({ id: IdSchema, name: v.string() })),
  /**
   * The user who owns the relationship.
   */
  owner: UserRefSchema,
  /**
   * Optimistic-concurrency version.
   */
  version: v.pipe(v.number(), v.integer(), v.minValue(1)),
  /**
   * Creation instant.
   */
  createdAt: TimestampSchema,
  /**
   * Last modification instant.
   */
  updatedAt: TimestampSchema
});

/**
 * A contact.
 */
export type Contact = v.InferOutput<typeof ContactSchema>;

/**
 * A contact with its recent history.
 */
export const ContactDetailSchema = v.strictObject({
  /**
   * The contact.
   */
  contact: ContactSchema,
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
 * Request body for creating a contact.
 *
 * A contact needs a name or a company (OnePageCRM-style lead capture). Supplying `companyName`
 * reuses an existing company with the same name (case-insensitively) or creates one; `companyId`
 * attaches the contact to a known company. The two are mutually exclusive.
 */
export const CreateContactInputSchema = v.pipe(
  v.strictObject({
    /**
     * Given name.
     */
    firstName: optionalText('First name', 100),
    /**
     * Family name.
     */
    lastName: optionalText('Last name', 100),
    /**
     * E-mail address.
     */
    email: OptionalEmailSchema,
    /**
     * Telephone number.
     */
    phone: optionalText('Phone', 40),
    /**
     * Job title.
     */
    jobTitle: optionalText('Job title', 100),
    /**
     * Existing company to attach to.
     */
    companyId: v.optional(v.nullable(IdSchema), null),
    /**
     * Company name to reuse or create.
     */
    companyName: optionalText('Company name', 200)
  }),
  v.forward(
    v.check(
      (input) =>
        input.firstName !== null
        || input.lastName !== null
        || input.companyName !== null
        || input.companyId !== null,
      'Enter a name or a company.'
    ),
    ['firstName']
  ),
  v.forward(
    v.check(
      (input) => input.companyId === null || input.companyName === null,
      'Choose an existing company or enter a new company name, not both.'
    ),
    ['companyName']
  )
);

/**
 * A validated create-contact request.
 */
export type CreateContactInput = v.InferOutput<typeof CreateContactInputSchema>;

/**
 * Request body for creating a company.
 */
export const CreateCompanyInputSchema = v.strictObject({
  /**
   * Company name.
   */
  name: requiredText('Company name', 200),
  /**
   * Business address.
   */
  address: optionalText('Address', 500),
  /**
   * Stock ticker symbol.
   */
  stockSymbol: StockSymbolSchema,
  /**
   * Companies House link.
   */
  companiesHouseUrl: CompaniesHouseUrlSchema
});

/**
 * A validated create-company request.
 */
export type CreateCompanyInput = v.InferOutput<typeof CreateCompanyInputSchema>;

/**
 * Request body for updating a company. Omitted fields are unchanged; `null` clears a field.
 */
export const UpdateCompanyInputSchema = v.pipe(
  v.strictObject({
    /**
     * New company name.
     */
    name: v.optional(requiredText('Company name', 200)),
    /**
     * New business address.
     */
    address: v.optional(optionalText('Address', 500)),
    /**
     * New stock symbol.
     */
    stockSymbol: v.optional(StockSymbolSchema),
    /**
     * New Companies House link.
     */
    companiesHouseUrl: v.optional(CompaniesHouseUrlSchema),
    /**
     * New primary contact; must be an active contact at this company.
     */
    primaryContactId: v.optional(v.nullable(IdSchema))
  }),
  v.check((input) => Object.keys(input).length > 0, 'Provide at least one field to change.')
);

/**
 * A validated update-company request.
 */
export type UpdateCompanyInput = v.InferOutput<typeof UpdateCompanyInputSchema>;

/**
 * Query string for listing or searching contacts and companies.
 *
 * Values arrive as strings from the URL, so `limit` is parsed from text.
 */
export const ListQuerySchema = v.strictObject({
  /**
   * Optional search term matched against names (and e-mail for contacts).
   */
  q: v.optional(SearchTermSchema),
  /**
   * Page size, 1–100.
   */
  limit: v.optional(
    v.pipe(
      v.string(),
      v.regex(/^\d{1,3}$/u, 'limit must be a whole number.'),
      v.transform(Number),
      v.minValue(1, 'limit must be at least 1.'),
      v.maxValue(MAX_PAGE_SIZE, `limit must be at most ${MAX_PAGE_SIZE}.`)
    )
  ),
  /**
   * Cursor from the previous page.
   */
  cursor: v.optional(CursorSchema)
});

/**
 * A validated list query.
 */
export type ListQuery = v.InferOutput<typeof ListQuerySchema>;

/**
 * One page of contact summaries.
 */
export const ContactPageSchema = pageSchema(ContactSummarySchema);

/**
 * One page of company summaries.
 */
export const CompanyPageSchema = pageSchema(CompanySummarySchema);

/**
 * Dashboard headline counts.
 */
export const DashboardSchema = v.strictObject({
  /**
   * Active contacts.
   */
  contacts: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /**
   * Active companies.
   */
  companies: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /**
   * Most recently changed contacts (at most 5).
   */
  recentContacts: v.array(ContactSummarySchema)
});

/**
 * Dashboard data.
 */
export type Dashboard = v.InferOutput<typeof DashboardSchema>;
