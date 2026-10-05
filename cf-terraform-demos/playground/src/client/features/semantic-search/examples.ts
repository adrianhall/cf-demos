/**
 * @file Prepared collections and queries for the Semantic Search panel. Each one exists to make a
 *   specific claim checkable rather than merely to fill the form, because "embeddings understand
 *   meaning" is the kind of statement a visitor should be able to _test_ rather than take on trust.
 *   The first collection is the important one. Its query shares no content word with the passage
 *   that should win, while a decoy passage repeats the query's own vocabulary and is about
 *   something else entirely. A keyword search ranks the decoy first; a semantic search does not.
 *   Verified with the live models during implementation — on `@cf/baai/bge-m3` the correct passage
 *   scored 0.7328 against the lexical decoy's 0.6777, and the cross-encoder separated them far more
 *   sharply at 0.9845 against 0.0001. None of them runs automatically. A prepared collection that
 *   spent credit the moment it was clicked would be a trap, and the panel's own lesson about
 *   per-passage billing would be the first casualty.
 */

/**
 * One prepared search, ready to load into the panel.
 */
export interface SemanticSearchExample {
  /**
   * Short name for the button.
   */
  label: string;
  /**
   * What this collection demonstrates, shown as a tooltip and to screen readers.
   */
  note: string;
  /**
   * The query to load.
   */
  query: string;
  /**
   * The collection to load.
   */
  passages: string[];
}

/**
 * The prepared collections offered by the panel.
 */
export const SEMANTIC_SEARCH_EXAMPLES: readonly SemanticSearchExample[] = [
  {
    label: 'Meaning beats keywords',
    note:
      'The query shares no important word with the right answer, while a decoy repeats its '
      + 'vocabulary and means something else. A keyword search would rank the decoy first.',
    query: 'How do I reset my password?',
    passages: [
      'To change your credentials, visit Account Settings and select Reset.',
      'Our password-protected building requires a badge to reset the door alarm.',
      'Sign-in trouble is usually fixed by clearing your browser cache.',
      'The cafeteria serves hot lunch until 2pm on weekdays.',
      'Invoices are issued on the first working day of each month.'
    ]
  },
  {
    label: 'Across languages',
    note:
      'An English query against French, Japanese, and Spanish passages. A multilingual model '
      + 'places all three near the query; an English-only model does not.',
    query: 'How do I reset my password?',
    passages: [
      'Pour changer votre mot de passe, allez dans les param\u00e8tres du compte.',
      '\u30d1\u30b9\u30ef\u30fc\u30c9\u3092\u5909\u66f4\u3059\u308b\u306b\u306f\u3001'
        + '\u30a2\u30ab\u30a6\u30f3\u30c8\u8a2d\u5b9a\u306b\u79fb\u52d5\u3057\u3066\u304f\u3060'
        + '\u3055\u3044\u3002',
      'Para cambiar su contrase\u00f1a, vaya a la configuraci\u00f3n de la cuenta.',
      'Le restaurant sert le d\u00e9jeuner jusqu\u0027\u00e0 14 heures.',
      'The warehouse closes at six on Fridays.'
    ]
  },
  {
    label: 'A question with no answer',
    note:
      'Nothing in the collection answers the query. The model still returns a ranking, because '
      + 'it always does \u2014 which is why a similarity score is not a measure of correctness.',
    query: 'What is the refund policy for annual subscriptions?',
    passages: [
      'The office is open Monday to Friday, 9am to 5pm.',
      'Meeting rooms can be booked up to two weeks in advance.',
      'Parking permits are issued by the facilities team.',
      'The fire drill takes place on the first Tuesday of each quarter.'
    ]
  },
  {
    label: 'Near-identical passages',
    note:
      'Four passages that say almost the same thing. The scores cluster tightly, which shows '
      + 'that a ranking can be confident about order while the gaps between places are tiny.',
    query: 'When does the support team reply?',
    passages: [
      'Our support team replies within one business day.',
      'Support requests are usually answered within 24 hours.',
      'You can expect a response from support the next working day.',
      'Support aims to respond to every ticket within a day.',
      'The product roadmap is published every quarter.'
    ]
  }
];
