import { forbidden, notFound } from '@adrianhall/cloudflare-toolkit/errors';
import type { Audience } from './audience';
import type { Faq } from './faq';
import type { Role } from './role';

/**
 * Everything the authorization rules need about the person making a request.
 *
 * Assembled by `../application/actor-resolver.ts` from the verified Access identity plus D1, and
 * never from anything the request carries. A field here that a client could influence would
 * silently become a privilege-escalation route, because every rule below reads from this object.
 */
export interface Actor {
  /**
   * Stable identity key, used as the owner reference on everything the actor creates.
   */
  identityKey: string;
  /**
   * Verified Cloudflare Access email.
   */
  email: string;
  /**
   * Role resolved from D1.
   */
  role: Role;
  /**
   * Effective audience clearance: the explicit value an administrator set, or the role default.
   */
  clearance: Audience;
  /**
   * Product slugs currently in scope, evaluated at action time against the live product map. Empty
   * for a salesperson and for a PM whose scope has not been configured.
   */
  productScopes: string[];
}

/**
 * Answer whether an actor administers the whole installation.
 *
 * @param actor Resolved actor.
 * @returns Whether the actor is an administrator.
 */
export function isAdministrator(actor: Actor): boolean {
  return actor.role === 'administrator';
}

/**
 * Answer whether an actor may manage knowledge for one product.
 *
 * An administrator may manage everything, including a cross-product FAQ that no PM's scope covers.
 * A PM may manage only the products currently in their scope. Everybody else may manage nothing,
 * however much of the knowledge base they are cleared to read — reading and editing are separate
 * permissions, and an overseer deliberately has only the first.
 *
 * @param actor Resolved actor.
 * @param productId Product the operation applies to, or `null` for a cross-product entry.
 * @returns Whether the actor may create, edit, or archive knowledge for that product.
 */
export function canManageProduct(actor: Actor, productId: string | null): boolean {
  if (isAdministrator(actor)) {
    return true;
  }
  if (actor.role !== 'pm' || productId === null) {
    return false;
  }
  return actor.productScopes.includes(productId);
}

/**
 * Answer whether an actor may edit a specific stored FAQ.
 *
 * Ownership alone is not enough and scope alone is not enough: a PM may edit an FAQ they own, and
 * one in a product they currently cover, because ownership can outlive a scope change and a
 * handover should not require the previous owner. An administrator may always edit, which is the
 * override the specification requires.
 *
 * @param actor Resolved actor.
 * @param faq Stored revision being edited.
 * @returns Whether the actor may publish a new revision of it.
 */
export function canEditFaq(
  actor: Actor,
  faq: Pick<Faq, 'ownerIdentityKey' | 'productId'>
): boolean {
  if (isAdministrator(actor)) {
    return true;
  }
  if (actor.role !== 'pm') {
    return false;
  }
  return actor.identityKey === faq.ownerIdentityKey || canManageProduct(actor, faq.productId);
}

/**
 * Require that an actor may edit a specific stored FAQ.
 *
 * @param actor Resolved actor.
 * @param faq Stored revision being edited.
 * @returns Nothing; it either passes or throws.
 * @throws {ProblemDetailsError} `forbidden()` (403) when a PM may manage knowledge but neither owns
 *   this FAQ nor covers its product; `notFound()` (404) when the actor has no management role, so
 *   the response cannot confirm the FAQ exists.
 */
export function requireFaqEdit(
  actor: Actor,
  faq: Pick<Faq, 'ownerIdentityKey' | 'productId'>
): void {
  if (canEditFaq(actor, faq)) {
    return;
  }
  if (actor.role === 'pm') {
    throw forbidden({ detail: 'You do not own this FAQ and its product is not in your scope.' });
  }
  throw notFound({ detail: 'FAQ not found.' });
}

/**
 * Require that an actor may manage a product, raising the safe failure otherwise.
 *
 * The two failures are deliberately different. A reader who may manage _something_ but not this
 * product gets `403`, because they already know the management surface exists and hiding it would
 * only be confusing. A reader with no management rights at all gets `404`, so the API cannot be
 * used to confirm that a particular FAQ or product exists.
 *
 * @param actor Resolved actor.
 * @param productId Product the operation applies to, or `null`.
 * @returns Nothing; it either passes or throws.
 * @throws {ProblemDetailsError} `forbidden()` (403) when a PM or administrator may manage knowledge
 *   but not this product; `notFound()` (404) when the actor has no management role.
 */
export function requireProductManagement(actor: Actor, productId: string | null): void {
  if (canManageProduct(actor, productId)) {
    return;
  }
  if (actor.role === 'pm' || actor.role === 'administrator') {
    throw forbidden({ detail: 'This product is not in your scope.' });
  }
  throw notFound({ detail: 'FAQ not found.' });
}
