/**
 * @file Record search for the note link chooser: one function that searches the existing list
 *   endpoint for a record type and maps the result to a {@link LinkOption}. Kept out of the chooser
 *   component so that component stays presentational and reusable.
 */

import type { NoteLink, NoteLinkType } from '../../shared/api/notes.ts';
import { type ApiClient, api } from './api-client.ts';
import type { LinkOption } from './note-draft.ts';

/**
 * Search one record type.
 *
 * @param type Record type.
 * @param text Search text; blank lists the first page.
 * @param client API client (injectable for tests).
 * @returns Up to one page of options.
 * @throws {ApiError} When the search fails.
 */
export async function searchLinkOptions(
  type: NoteLinkType,
  text: string,
  client: ApiClient = api
): Promise<LinkOption[]> {
  const query = text === '' ? {} : { q: text };
  switch (type) {
    case 'contact':
      return (await client.contacts(query)).items.map((item) => ({
        type,
        id: item.id,
        label: item.displayName
      }));
    case 'company':
      return (await client.companies(query)).items.map((item) => ({
        type,
        id: item.id,
        label: item.name
      }));
    case 'deal':
      return (await client.deals(query)).items.map((item) => ({
        type,
        id: item.id,
        label: item.title
      }));
    default:
      // `project` — the last of the closed set of link types.
      return (await client.projects(query)).items.map((item) => ({
        type,
        id: item.id,
        label: item.name
      }));
  }
}

/**
 * The route that shows a linked record.
 *
 * @param link The link.
 * @returns A named route location.
 */
export function linkRoute(link: Pick<NoteLink, 'type' | 'id'>): {
  name: NoteLinkType;
  params: { id: string };
} {
  return { name: link.type, params: { id: link.id } };
}
