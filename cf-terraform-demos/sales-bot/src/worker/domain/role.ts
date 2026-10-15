/**
 * Roles used by the SalesBot authorization boundary.
 */
export type Role = 'salesperson' | 'pm' | 'overseer' | 'administrator';

/**
 * Answers whether a role may open management navigation.
 *
 * @param role Verified actor role resolved by the application.
 * @returns Whether the actor may access management capabilities.
 */
export function canManage(role: Role): boolean {
  return role === 'pm' || role === 'overseer' || role === 'administrator';
}
