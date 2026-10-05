/**
 * @file The Playground's panel catalogue: one flat list of plainly named, action-first
 *   destinations. This file sits at `src/` rather than under `src/worker/` because it is genuinely
 *   shared by both tiers, in the same way `src/access-policies.ts` is in the sibling demos. The
 *   Worker serves it from `/api/catalogue` and validates task identifiers against it; the browser
 *   builds its navigation and routes from the same constants. One definition means a panel cannot
 *   exist in the sidebar without a matching task, or be accepted by the API without appearing in
 *   the UI. It contains no bindings, no secrets, and no model contracts — only the panel list — so
 *   sharing it with browser code leaks nothing. Model descriptors deliberately stay in
 *   `src/worker/domain/models.ts` and reach the browser only through `/api/catalogue`.
 */

/**
 * Identifier of a Playground panel.
 *
 * These are the route segments as well as the API task identifiers, so a panel's URL, its
 * descriptor, and its server-side validation all agree by construction. Names are actions a person
 * would recognise ("Create Image"), not product nouns or model task names.
 */
export type TaskId =
  | 'chat'
  | 'create-image'
  | 'describe-image'
  | 'remix-image'
  | 'classify-image'
  | 'detect-objects'
  | 'create-video'
  | 'animate-image'
  | 'generate-music'
  | 'read-text'
  | 'transcribe-audio'
  | 'translate-text'
  | 'classify-text'
  | 'evaluate-choices'
  | 'semantic-search'
  | 'view-tokens';

/**
 * How a panel's work reaches a model, which decides whether it produces cost and gateway logs.
 *
 * - `required` — the panel performs inference and **must** route through AI Gateway. Every inference
 *   panel in this demo uses this value; there is no "optional" or "preferred" variant, because a
 *   gateway that can be skipped is not a control point.
 * - `none` — the panel performs no inference at all. Only `view-tokens` qualifies: it tokenizes in
 *   the browser, so there is no request to route, no log to read, and nothing to charge. This is
 *   explicitly _not_ an AI Gateway exception; see `AI-GATEWAY-EXCEPTIONS.md`.
 */
export type GatewayRequirement = 'required' | 'none';

/**
 * Delivery phase of a panel, as defined by `specs/playground/02-implementation.md`.
 *
 * Every panel appears in the navigation from the first phase, including the ones that are not built
 * yet. Hiding them would misrepresent the product and make each phase's progress invisible; an
 * honest "not built yet" placeholder is more useful to a visitor than a sidebar that silently
 * grows.
 */
export type TaskAvailability = 'available' | 'planned';

/**
 * Purely visual grouping label for the sidebar.
 *
 * Groups are labels, never navigation. They do not expand, collapse, filter, or route, and no panel
 * is reachable only by going "through" a group. The navigation stays exactly one level deep.
 */
export type TaskGroup = 'Generate' | 'Understand' | 'Speech' | 'Reason' | 'Inspect';

/**
 * One Playground panel: its route, its human-facing name, the technical task type behind it, and
 * whether it creates gateway-routed inference.
 */
export interface TaskDescriptor {
  /**
   * Stable identifier, also used as the route segment and the API task parameter.
   */
  id: TaskId;
  /**
   * Action-first panel name shown in the sidebar and as the page title.
   */
  name: string;
  /**
   * Technical model task type shown as the panel subtitle, so a visitor can map the plain name onto
   * the vocabulary used by the model catalog and the wider industry.
   */
  taskType: string;
  /**
   * One-sentence description of what the panel does for the person using it.
   */
  summary: string;
  /**
   * Visual sidebar grouping. Decorative only; see {@link TaskGroup}.
   */
  group: TaskGroup;
  /**
   * Whether this panel's work must be routed through AI Gateway.
   */
  gateway: GatewayRequirement;
  /**
   * Whether the panel is built yet, or still shows a placeholder.
   */
  availability: TaskAvailability;
  /**
   * Implementation phase that delivers the panel, quoted in the placeholder so a visitor knows what
   * is coming rather than only what is missing.
   */
  phase: number;
}

/**
 * Every Playground panel, in sidebar order.
 *
 * The order is editorial: the panels a visitor is most likely to recognise come first, and the
 * inspection tooling comes last. Groups cluster related panels visually without nesting them.
 */
export const TASK_DESCRIPTORS: readonly TaskDescriptor[] = [
  {
    id: 'chat',
    name: 'Chat',
    taskType: 'Text generation',
    summary: 'Hold a short conversation with a text model and watch the answer stream in.',
    group: 'Generate',
    gateway: 'required',
    availability: 'available',
    phase: 3
  },
  {
    id: 'create-image',
    name: 'Create Image',
    taskType: 'Text to image',
    summary: 'Turn a written description into a picture.',
    group: 'Generate',
    gateway: 'required',
    availability: 'available',
    phase: 4
  },
  {
    id: 'describe-image',
    name: 'Describe Image',
    taskType: 'Image to text',
    summary: 'Ask a vision model what is in a picture.',
    group: 'Understand',
    gateway: 'required',
    availability: 'available',
    phase: 5
  },
  {
    id: 'remix-image',
    name: 'Remix Image',
    taskType: 'Image to image',
    summary: 'Transform a picture you supply using a written instruction.',
    group: 'Generate',
    gateway: 'required',
    availability: 'available',
    phase: 6
  },
  {
    id: 'classify-image',
    name: 'Classify Image',
    taskType: 'Image classification',
    summary: 'Sort a picture into labels the model already knows, with confidence scores.',
    group: 'Understand',
    gateway: 'required',
    availability: 'available',
    phase: 7
  },
  {
    id: 'detect-objects',
    name: 'Detect Objects',
    taskType: 'Object detection',
    summary: 'Find where things are in a picture, not just what the picture is of.',
    group: 'Understand',
    gateway: 'required',
    availability: 'planned',
    phase: 17
  },
  {
    id: 'create-video',
    name: 'Create Video',
    taskType: 'Text to video',
    summary: 'Generate a short video clip from a written description.',
    group: 'Generate',
    gateway: 'required',
    availability: 'available',
    phase: 8
  },
  {
    id: 'animate-image',
    name: 'Animate Image',
    taskType: 'Image to video',
    summary: 'Bring a still picture to life as a short video clip.',
    group: 'Generate',
    gateway: 'required',
    availability: 'planned',
    phase: 16
  },
  {
    id: 'generate-music',
    name: 'Generate Music',
    taskType: 'Text to music',
    summary: 'Compose a short piece of music from a style description.',
    group: 'Generate',
    gateway: 'required',
    availability: 'available',
    phase: 15
  },
  {
    id: 'read-text',
    name: 'Read Text',
    taskType: 'Text to speech',
    summary: 'Hear written text spoken aloud in a chosen voice.',
    group: 'Speech',
    gateway: 'required',
    availability: 'available',
    phase: 9
  },
  {
    id: 'transcribe-audio',
    name: 'Transcribe Audio',
    taskType: 'Automatic speech recognition',
    summary: 'Turn recorded speech into written text.',
    group: 'Speech',
    gateway: 'required',
    availability: 'available',
    phase: 10
  },
  {
    id: 'translate-text',
    name: 'Translate Text',
    taskType: 'Translation',
    summary: 'Translate text between languages a model supports.',
    group: 'Understand',
    gateway: 'required',
    availability: 'available',
    phase: 11
  },
  {
    id: 'classify-text',
    name: 'Classify Text',
    taskType: 'Text classification',
    summary: 'Sort text into a fixed set of labels such as sentiment or topic.',
    group: 'Understand',
    gateway: 'required',
    availability: 'available',
    phase: 12
  },
  {
    id: 'evaluate-choices',
    name: 'Evaluate Choices',
    taskType: 'Structured evaluation',
    summary:
      'Ask typed yes/no, multiple-choice, and scoring questions about a situation and get '
      + 'calibrated probabilities back rather than prose.',
    group: 'Reason',
    gateway: 'required',
    availability: 'available',
    phase: 14
  },
  {
    id: 'semantic-search',
    name: 'Semantic Search',
    taskType: 'Text embeddings',
    summary: 'Find passages by meaning rather than by matching words.',
    group: 'Reason',
    gateway: 'required',
    availability: 'available',
    phase: 13
  },
  {
    id: 'view-tokens',
    name: 'View Tokens',
    taskType: 'Tokenization (runs in your browser)',
    summary:
      'See exactly how a model would split your text into tokens. Nothing leaves your browser.',
    group: 'Inspect',
    // Not an exception: there is no inference request here to route anywhere. See
    // AI-GATEWAY-EXCEPTIONS.md, which says so explicitly so the absence is a decision rather than
    // an oversight.
    gateway: 'none',
    availability: 'available',
    phase: 2
  }
];

/**
 * Looks up a panel descriptor by its identifier.
 *
 * @param id Candidate task identifier, typically straight from a URL path or an API parameter and
 *   therefore untrusted.
 * @returns The matching descriptor, or `undefined` when the identifier is not a known panel.
 */
export function findTask(id: string): TaskDescriptor | undefined {
  return TASK_DESCRIPTORS.find((task) => task.id === id);
}

/**
 * Reports whether a string is a known panel identifier.
 *
 * @param id Candidate task identifier from an untrusted source.
 * @returns `true` when the identifier names a panel in {@link TASK_DESCRIPTORS}.
 */
export function isTaskId(id: string): id is TaskId {
  return findTask(id) !== undefined;
}
