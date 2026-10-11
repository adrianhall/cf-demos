/**
 * @file Pure CRM rules for companies and contacts.
 */

/**
 * Compute the name a contact is shown and sorted by.
 *
 * OnePageCRM-style lead capture allows a contact with only a company name, so the company name is
 * the fallback when no personal name is known.
 *
 * @param firstName Given name, if any.
 * @param lastName Family name, if any.
 * @param companyName Company name, if any.
 * @returns The display name.
 * @throws {Error} When none of the three is present; callers validate first, so this indicates a
 *   programming error rather than bad input.
 */
export function contactDisplayName(
  firstName: string | null,
  lastName: string | null,
  companyName: string | null
): string {
  const personal = [firstName, lastName].filter((part): part is string => part !== null).join(' ');
  if (personal.length > 0) {
    return personal;
  }
  if (companyName !== null) {
    return companyName;
  }
  throw new Error('A contact needs a name or a company.');
}

/**
 * The key two company names are compared by when deciding whether to reuse a company.
 *
 * Matches the `lower(name)` unique index in the migration, so the application's reuse lookup and
 * the database's uniqueness guarantee agree on what "the same company" means.
 *
 * @param name Company name.
 * @returns The comparison key.
 */
export function companyNameKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Escape a user search term for a SQL `LIKE ... ESCAPE '\'` contains-match.
 *
 * @param term The raw term.
 * @returns A pattern matching the term literally anywhere in a value.
 */
export function likeContains(term: string): string {
  return `%${term.toLowerCase().replace(/[\\%_]/gu, (char) => `\\${char}`)}%`;
}
