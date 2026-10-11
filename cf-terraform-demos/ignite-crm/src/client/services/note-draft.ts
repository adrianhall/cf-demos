/**
 * @file Convert the note form's draft into API requests. An edit sends only what changed, measured
 *   against the note as it was when the editor opened, so after a conflict and "Load latest
 *   version" a field the user did not touch keeps the other person's change.
 */

import type {
  CreateNoteInput,
  Note,
  NoteLinkRef,
  NoteLinkType,
  UpdateNoteInput
} from '../../shared/api/notes.ts';

/**
 * One chosen or candidate record in the link chooser.
 */
export interface LinkOption {
  /**
   * Record type.
   */
  readonly type: NoteLinkType;
  /**
   * Record id.
   */
  readonly id: string;
  /**
   * Display label.
   */
  readonly label: string;
  /**
   * `false` for a link whose record has been deleted; it can be removed but not opened.
   */
  readonly available?: boolean;
}

/**
 * Display names for each record type.
 */
export const LINK_TYPE_LABELS: Readonly<Record<NoteLinkType, string>> = {
  contact: 'Contact',
  company: 'Company',
  deal: 'Deal',
  project: 'Project'
};

/**
 * The note form's draft.
 */
export interface NoteFormValue {
  /**
   * Title.
   */
  title: string;
  /**
   * Markdown body.
   */
  markdown: string;
  /**
   * Linked records, in display order.
   */
  links: LinkOption[];
}

/**
 * The draft's links as request references, in display order.
 *
 * @param value The draft.
 * @returns Type and id pairs.
 */
function linkRefs(value: NoteFormValue): NoteLinkRef[] {
  return value.links.map((link) => ({ type: link.type, id: link.id }));
}

/**
 * A canonical key for a link set, independent of order.
 *
 * @param links The links.
 * @returns A comparable string.
 */
function linkSetKey(links: readonly NoteLinkRef[]): string {
  return links
    .map((link) => `${link.type}:${link.id}`)
    .sort()
    .join(',');
}

/**
 * Build a create request.
 *
 * @param value The draft.
 * @returns The request.
 */
export function toCreateNoteInput(value: NoteFormValue): CreateNoteInput {
  return { title: value.title, markdown: value.markdown, links: linkRefs(value) };
}

/**
 * Build an update request containing only changed fields.
 *
 * @param base The note as the editor opened it.
 * @param value The draft.
 * @returns The request, or `null` when nothing changed.
 */
export function toUpdateNoteInput(base: Note, value: NoteFormValue): UpdateNoteInput | null {
  const changes: { title?: string; markdown?: string; links?: NoteLinkRef[] } = {};
  if (value.title.trim() !== base.title) {
    changes.title = value.title;
  }
  if (value.markdown.replace(/\r\n?/gu, '\n') !== base.markdown) {
    changes.markdown = value.markdown;
  }
  const links = linkRefs(value);
  if (linkSetKey(links) !== linkSetKey(base.links)) {
    changes.links = links;
  }
  return Object.keys(changes).length === 0 ? null : (changes as UpdateNoteInput);
}
