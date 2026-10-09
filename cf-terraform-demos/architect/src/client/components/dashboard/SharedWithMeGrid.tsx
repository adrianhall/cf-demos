import { useCallback, useEffect, useRef, useState } from 'react';
import type { DiagramSummary } from '../../api/diagrams.ts';
import { listSharedWithMe } from '../../api/diagrams.ts';
import { DiagramCard } from './DiagramCard.tsx';

/**
 * The dashboard's second section: diagrams somebody else owns and has granted the visitor edit
 * access to.
 *
 * It reuses {@link DiagramCard} rather than introducing a second card, because the thing on screen
 * genuinely is the same thing — a diagram, its title linking to the same editor, and a thumbnail of
 * its graph. What differs is one badge naming the owner, which the card already has a slot for.
 *
 * Two deliberate omissions mark it as somebody else's diagram:
 *
 * - **No per-card menu.** Duplicate and Delete are owner-only server-side, so offering them here
 *   would be offering actions the server refuses. Leaving a diagram is done from inside the editor,
 *   beside the list of who else has access, where the visitor can see what they are leaving.
 * - **No create control.** This section is not a place new diagrams can appear; the owner's own
 *   section above it is.
 *
 * The whole section renders nothing when the visitor collaborates on nothing, rather than showing
 * an empty state. An empty "My Diagrams" is worth explaining because it is a prompt to create one;
 * an empty "Shared with me" is just the ordinary case for most people, and a standing empty box
 * saying so would be noise on every dashboard.
 *
 * A load failure is likewise not rendered as an error. This section is secondary to the owner's own
 * diagrams, which have loaded independently above it, and a red alert about a list the visitor may
 * not even use would misreport the state of the page. The section simply stays absent, exactly as
 * it does when there is nothing to show.
 *
 * @returns The section, or `null` when the visitor collaborates on nothing or the list could not be
 *   loaded.
 */
export function SharedWithMeGrid() {
  const [diagrams, setDiagrams] = useState<DiagramSummary[]>([]);

  /**
   * Whether this component is still mounted.
   *
   * The same guard {@link DiagramGrid} uses, for the same reason: a request that resolves after the
   * visitor has navigated away would commit state into a tree that is no longer on screen.
   */
  const mounted = useRef(true);

  const load = useCallback(async () => {
    // Resolved before anything is committed, and the failure branch yields an empty list rather
    // than an error state — see this component's own documentation for why a failure here is
    // silent.
    const loaded = await listSharedWithMe().then(
      (result) => result,
      () => [] as DiagramSummary[]
    );

    if (mounted.current) {
      setDiagrams(loaded);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  if (diagrams.length === 0) {
    return null;
  }

  return (
    <section className="dashboard__shared-section">
      <div className="dashboard__header">
        <h2 className="dashboard__title">Shared with me</h2>
      </div>
      <div className="dashboard__grid">
        {diagrams.map((diagram) => (
          <DiagramCard
            key={diagram.id}
            diagram={diagram}
            // The one visible difference from an owned card, and the reason the card takes a slot
            // for it: without the owner's address, two diagrams with the same title in the two
            // sections would be indistinguishable.
            ownerBadge={`Shared by ${diagram.ownerEmail}`}
          />
        ))}
      </div>
    </section>
  );
}
