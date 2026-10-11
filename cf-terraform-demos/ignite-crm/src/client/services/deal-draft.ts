/**
 * @file Convert the deal form's value into API requests. Kept out of the components so the rules —
 *   pounds already converted to pence, blanks become `null`, and an update sends only changed
 *   fields — are unit-testable and shared by every screen that edits deals.
 */

import type { CreateDealInput, Deal, DealStatus, UpdateDealInput } from '../../shared/api/sales.ts';

/**
 * A contact chosen in a picker.
 */
export interface PickedContact {
  /**
   * Contact id.
   */
  id: string;
  /**
   * Display name.
   */
  displayName: string;
  /**
   * The contact's company, when known (search results carry it).
   */
  companyId?: string | null;
}

/**
 * The values the deal form submits. Pounds are already converted to integer pence.
 */
export interface DealFormValue {
  /**
   * Title.
   */
  title: string;
  /**
   * Primary contact (with its company, when known).
   */
  contact: PickedContact;
  /**
   * Whether to file under the contact's company.
   */
  withCompany: boolean;
  /**
   * Stage id.
   */
  stageId: string;
  /**
   * Outcome.
   */
  status: DealStatus;
  /**
   * Amount in minor units.
   */
  amountMinor: number;
  /**
   * Status line ('' for none).
   */
  statusLine: string;
  /**
   * Next action text ('' for none).
   */
  nextActionText: string;
  /**
   * Next action date ('' for none).
   */
  nextActionDate: string;
  /**
   * Expected close date ('' for none).
   */
  expectedCloseDate: string;
  /**
   * Owner id.
   */
  ownerId: string;
}

/**
 * A blank string as `null`.
 *
 * @param value Form text.
 * @returns The trimmed text, or `null` when blank.
 */
function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Build a create-deal request.
 *
 * Filing under the contact's company is expressed by omitting `companyId` — the server then uses
 * the primary contact's current company — so the client never has to know it.
 *
 * @param value The form value.
 * @param callerId The signed-in user's id; the owner is sent only when it differs.
 * @returns The request body.
 */
export function toCreateDealInput(
  value: DealFormValue,
  callerId: string
): Partial<CreateDealInput> {
  return {
    title: value.title,
    primaryContactId: value.contact.id,
    ...(value.withCompany ? {} : { companyId: null }),
    stageId: value.stageId,
    amountMinor: value.amountMinor,
    statusLine: blankToNull(value.statusLine),
    nextActionText: blankToNull(value.nextActionText),
    nextActionDate: blankToNull(value.nextActionDate),
    expectedCloseDate: blankToNull(value.expectedCloseDate),
    ...(value.ownerId !== '' && value.ownerId !== callerId ? { ownerId: value.ownerId } : {})
  };
}

/**
 * Build an update-deal request containing only the fields that changed.
 *
 * @param deal The deal as last loaded.
 * @param value The form value.
 * @returns The changed fields, or `null` when nothing changed.
 */
export function toUpdateDealInput(deal: Deal, value: DealFormValue): UpdateDealInput | null {
  const changes: Record<string, unknown> = {};
  const set = (field: keyof UpdateDealInput, next: unknown, current: unknown): void => {
    if (next !== current) {
      changes[field] = next;
    }
  };
  set('title', value.title.trim(), deal.title);
  set('primaryContactId', value.contact.id, deal.primaryContact.id);
  // The company follows the chosen contact; it is sent whenever it or the contact changes so the
  // server validates the pair together.
  const companyId = value.withCompany ? (value.contact.companyId ?? null) : null;
  if (companyId !== (deal.company?.id ?? null) || changes.primaryContactId !== undefined) {
    changes.companyId = companyId;
  }
  set('stageId', value.stageId, deal.stage.id);
  set('status', value.status, deal.status);
  set('amountMinor', value.amountMinor, deal.amountMinor);
  set('statusLine', blankToNull(value.statusLine), deal.statusLine);
  if (value.status === 'pending') {
    set('nextActionText', blankToNull(value.nextActionText), deal.nextActionText);
    set('nextActionDate', blankToNull(value.nextActionDate), deal.nextActionDate);
  }
  set('expectedCloseDate', blankToNull(value.expectedCloseDate), deal.expectedCloseDate);
  // Only an owner/manager submits an explicit assignment. The server requires `crm.assign` for
  // any supplied ownerId, even when it matches the current owner.
  if (value.ownerId !== deal.owner.id) {
    changes.ownerId = value.ownerId;
  }
  return Object.keys(changes).length === 0 ? null : (changes as UpdateDealInput);
}
