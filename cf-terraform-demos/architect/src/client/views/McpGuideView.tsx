import { AlertTriangle, type Icon, Share2, Terminal } from 'react-feather';
import { MCP_ROUTE } from '../../mcp-route.ts';
import { AppHeader } from '../components/AppHeader.tsx';
import { CopyBlock } from '../components/guide/CopyBlock.tsx';
import { useIdentity } from '../hooks/useIdentity.ts';
import { TOOL_GROUPS } from './mcp-tool-catalogue.ts';

/**
 * One connectable agent harness.
 *
 * Modelled as data with a renderer rather than written inline, because the surface is expected to
 * grow: OpenCode is the harness this demo has actually been validated against
 * (`MCP-VALIDATION.md`), and others will be documented as they are. Keeping the shape explicit
 * means adding one is adding an entry, not restructuring the page. There is deliberately no tab
 * strip and no "coming soon" placeholder: an empty affordance for undocumented harnesses would
 * promise the reader something this page does not have.
 */
interface Harness {
  /**
   * Harness name as its own documentation spells it, used as the section heading.
   */
  name: string;
  /**
   * One sentence on what this harness is and why it appears here.
   */
  summary: string;
  /**
   * Configuration file the snippet below belongs in, shown as the block's caption.
   */
  configFile: string;
  /**
   * Builds the configuration snippet for a deployment, given its resolved endpoint URL.
   *
   * A function rather than a string so the endpoint is substituted at render time from the
   * browser's own origin. See {@link McpGuideView} for why this value is never a literal.
   *
   * @param endpoint Absolute URL of this deployment's MCP endpoint.
   * @returns The snippet's exact text, ready to copy.
   */
  config: (endpoint: string) => string;
  /**
   * Operator commands, each with the question it answers.
   */
  commands: { command: string; purpose: string }[];
}

/**
 * The harnesses this demo documents.
 */
const HARNESSES: Harness[] = [
  {
    name: 'OpenCode',
    summary:
      'The reference client for this demo, and the one MCP-VALIDATION.md is written against. Any '
      + 'client that implements OAuth Dynamic Client Registration against a remote HTTP server '
      + 'works the same way.',
    configFile: 'opencode.json',
    config: (endpoint) =>
      `{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "architect": {
        "type": "remote",
        "url": "${endpoint}"
      }
    }
  }
}`,
    commands: [
      {
        command: 'opencode mcp auth architect',
        purpose:
          'Starts the browser login. Run this once; the credentials are stored outside the '
          + 'configuration file, so nothing secret is ever written into the JSON above.'
      },
      {
        command: 'opencode mcp list',
        purpose:
          'Shows every configured server and whether it is connected or still needs '
          + 'authentication.'
      },
      {
        command: 'opencode mcp debug architect',
        purpose:
          'Reports what happened during a failed OAuth round trip — discovery, registration, or '
          + 'the redirect back — rather than leaving a connection failure unexplained.'
      }
    ]
  }
];

/**
 * One worked example: what to ask, and what the agent actually does.
 */
interface ExamplePrompt {
  /**
   * Heading for the example, naming the task in the reader's terms.
   */
  title: string;
  /**
   * The prompt itself, copyable verbatim.
   */
  prompt: string;
  /**
   * What happens when the agent runs it.
   */
  outcome: string;
  /**
   * Tool names the agent calls, in the order it calls them. Empty when the request cannot be served
   * by a tool at all, which is itself the point of the example.
   */
  tools: string[];
  /**
   * What the MCP server genuinely cannot do here, stated plainly, and the route that does work.
   *
   * Present on exactly the examples where a reader's reasonable expectation is wrong. Writing the
   * gap next to the prompt that triggers it is deliberate: a limitation recorded only in a footnote
   * is one a reader meets as a surprise.
   */
  gap?: { limitation: string; instead: string };
}

/**
 * The prompts a visitor is most likely to try first.
 */
const PROMPTS: ExamplePrompt[] = [
  {
    title: 'Start a diagram from a blueprint',
    prompt:
      'Create a diagram called "Checkout service" from the api-gateway blueprint, then tell me '
      + 'what is on it.',
    outcome:
      'The agent creates a diagram owned by you and seeds it from one of the 22 blueprint '
      + 'templates in the public gallery, then reads the graph back to describe it. An unknown '
      + 'blueprint slug is refused and nothing is created, so a mistyped name cannot leave you '
      + 'with a blank diagram you did not ask for.',
    tools: ['create_diagram', 'get_diagram']
  },
  {
    title: 'Add to a diagram while you watch',
    prompt:
      'Add a D1 node called Orders to that diagram and connect the gateway Worker to it with a '
      + 'service-binding edge.',
    outcome:
      'This is the one to try with the editor open in another tab. The canvas updates as the '
      + 'agent works — no reload and no polling — and shows an "Updated by an agent" notice '
      + 'explaining why the diagram just changed under you. Both endpoints of an edge must '
      + 'already exist, so the agent adds nodes before the edges between them.',
    tools: ['add_node', 'add_edge']
  },
  {
    title: 'Download an image of a diagram',
    prompt: 'Export that diagram as a PNG and save it to my desktop.',
    outcome:
      'The agent should decline, and its tools are described so that it does rather than '
      + 'promising a file it cannot produce.',
    tools: [],
    gap: {
      limitation:
        'The MCP server has no image capability today. export_diagram offers json and scaffold '
        + 'only. PNG and SVG are produced by rasterising the live React Flow canvas with '
        + 'html-to-image, and there is no DOM in a Worker to rasterise, so there is nothing for a '
        + 'server-side tool to capture.',
      instead:
        'Use the Export button in the editor, which produces the PNG or SVG in your browser and '
        + 'saves it locally. The agent can still hand you the diagram as data — ask it for '
        + 'export_diagram with json for the raw graph, or with scaffold for a ready-to-deploy '
        + 'Cloudflare starter project.'
    }
  },
  {
    title: 'Put a diagram into a markdown document',
    prompt: 'Insert an image of that diagram into the architecture section of my README.',
    outcome:
      'The agent can edit the document, but it cannot originate the image, for exactly the reason '
      + 'above — so the picture has to come from the editor first.',
    tools: [],
    gap: {
      limitation:
        'There is no tool that returns an image, so an agent cannot produce the file your '
        + 'markdown would reference.',
      instead:
        'Export the PNG or SVG from the editor, save it next to your document, and reference it '
        + 'from the markdown. If a live view suits the document better than a still image, ask '
        + 'the agent for create_share_link instead: that returns a read-only URL anyone can open '
        + 'without signing in, which you can link from the page and which always shows the '
        + 'current diagram rather than a snapshot.'
    }
  }
];

/**
 * Props for {@link GuideNote}.
 */
interface GuideNoteProps {
  /**
   * Icon shown beside the note. Decorative: the note's own text carries every meaning.
   */
  icon: Icon;
  /**
   * Short label naming the kind of note, for example `No image support`.
   */
  title: string;
  /**
   * The note's body.
   */
  children: React.ReactNode;
}

/**
 * A callout drawing attention to something a reader would otherwise assume wrongly.
 *
 * Not a heading: these appear inside cards that already have one, and promoting a callout to a
 * heading would put it in the document outline as a peer of the example it qualifies. The icon is
 * `aria-hidden` and the label is real text, so the callout reads correctly with images off and does
 * not depend on colour alone.
 *
 * @param props Icon, label and body; see {@link GuideNoteProps}.
 * @returns The callout.
 */
function GuideNote({ icon: NoteIcon, title, children }: GuideNoteProps) {
  return (
    <div className="guide__note">
      <NoteIcon className="guide__note-icon" size={18} aria-hidden="true" />
      <div>
        <p className="guide__note-title">{title}</p>
        <p className="guide__note-body">{children}</p>
      </div>
    </div>
  );
}

/**
 * Public guide to connecting an agent harness to this deployment's remote MCP server, served at
 * `MCP_GUIDE_ROUTE` (`src/mcp-route.ts`).
 *
 * Public on purpose, and in the same way the landing page and the blueprint gallery are: it teaches
 * somebody how to connect _before_ they have signed in, so a page that redirected to a login would
 * be useless at the one moment it is needed. That posture comes from the catch-all in
 * `src/access-policies.ts` and from this path being absent from `infra/access.tf`'s destination
 * list — see `MCP_GUIDE_ROUTE`'s own documentation for the prefix collision that would quietly undo
 * it.
 *
 * **The endpoint URL is derived, never written down.** It is built from `window.location.origin`
 * and the shared {@link MCP_ROUTE} constant, so the snippet a reader copies always names the
 * deployment they are reading it on. A literal would be wrong three times over: the hostname is a
 * Terraform variable (`infra/providers.tf`), `pnpm check:naming` rejects a hard-coded host in a
 * committed file, and this demo is deployed alongside the implementation it was ported from — so a
 * stale literal here could hand a reader a working URL pointing at the wrong deployment.
 *
 * Everything the page claims is true of the code it describes. The tool list mirrors
 * `src/worker/mcp/server.ts`, the authentication story mirrors `infra/access.tf`, and the image gap
 * is stated rather than elided, because `export_diagram` genuinely offers `json` and `scaffold`
 * only.
 *
 * @returns The guide page.
 */
export function McpGuideView() {
  const identity = useIdentity();

  // Derived at render from the document's own origin. Reading `window.location` directly rather
  // than threading it through props matches `../App.tsx`, which resolves the whole view this way.
  const endpoint = `${window.location.origin}${MCP_ROUTE}`;

  return (
    <div className="app-shell">
      <AppHeader identity={identity} current="mcp-guide" access="public" />
      <main className="app-shell__main guide">
        <div className="guide__intro">
          <p className="landing__hero-eyebrow">Model Context Protocol</p>
          <h1>Connect an AI agent to your diagrams</h1>
          <p className="guide__lede">
            This deployment serves a remote MCP server, so an agent in your editor or terminal can
            read and change your diagrams with exactly the authority you have in the browser &mdash;
            and no more. Connect it once, then ask it to build something and watch the canvas change
            while you do.
          </p>
        </div>

        <section className="guide__section" aria-labelledby="endpoint-title">
          <h2 className="guide__section-title" id="endpoint-title">
            The endpoint
          </h2>
          {/* The possessive is written as one JSX expression rather than as `deployment&rsquo;s`
              split across a line break: JSX collapses the newline between a text node and an
              entity into a space, which rendered as "this deployment ’s own address". */}
          <p className="guide__text">
            Point your client at this URL as a remote MCP server over HTTP. It is{' '}
            {'this deployment\u2019s own address'}, so it is already correct for wherever you are
            reading this.
          </p>
          <CopyBlock code={endpoint} label="the MCP endpoint URL" language="URL" />
          <GuideNote icon={Share2} title="You sign in as yourself">
            The login is the <strong>same Cloudflare Access login the editor uses</strong>, because
            it is the same Access application. There is no second account to create, no API key to
            paste, and no machine identity: the agent acts strictly as the signed-in user, sees only
            that user&rsquo;s diagrams, and loses access the moment that identity does.
          </GuideNote>
        </section>

        {HARNESSES.map((harness) => (
          <section
            className="guide__section"
            key={harness.name}
            aria-labelledby={`harness-${harness.name.toLowerCase()}`}
          >
            <h2 className="guide__section-title" id={`harness-${harness.name.toLowerCase()}`}>
              Connecting {harness.name}
            </h2>
            <p className="guide__text">{harness.summary}</p>

            <h3 className="guide__subsection-title">Configuration</h3>
            <p className="guide__text">
              Add the server to your <code>{harness.configFile}</code>:
            </p>
            <CopyBlock
              code={harness.config(endpoint)}
              label={`the ${harness.name} configuration`}
              language={harness.configFile}
            />

            <h3 className="guide__subsection-title">Signing in</h3>
            <p className="guide__text">
              Remote servers use OAuth by default, so no credential belongs in the file above.
            </p>
            <dl className="guide__commands">
              {harness.commands.map((entry) => (
                <div className="guide__command" key={entry.command}>
                  <dt>
                    <CopyBlock code={entry.command} label={`the ${entry.command} command`} />
                  </dt>
                  <dd className="guide__command-purpose">{entry.purpose}</dd>
                </div>
              ))}
            </dl>
            <GuideNote icon={Terminal} title="Why loopback redirects are allowed">
              {harness.name}&rsquo;s OAuth client redirects to a fixed loopback address on your own
              machine. Cloudflare Access&rsquo;s <code>allowed_uris</code> field requires an{' '}
              <code>https</code> URL and so cannot express one at all, which is why this
              deployment&rsquo;s Access application enables <code>allow_any_on_loopback</code>. That
              is the only mechanism that admits a native client &mdash; it widens nothing else,
              because the identity still has to pass the same policy that guards the editor.
            </GuideNote>
          </section>
        ))}

        <section className="guide__section" aria-labelledby="prompts-title">
          <h2 className="guide__section-title" id="prompts-title">
            What to ask it
          </h2>
          <p className="guide__text">
            Four things worth trying first, including two that do not work the way most people
            expect.
          </p>
          <div className="guide__prompts">
            {PROMPTS.map((example) => (
              <article className="guide__prompt" key={example.title}>
                <h3 className="guide__prompt-title">{example.title}</h3>
                <CopyBlock code={example.prompt} label={`the "${example.title}" prompt`} />
                <p className="guide__text">{example.outcome}</p>
                {example.tools.length > 0 && (
                  <p className="guide__prompt-tools">
                    <span className="guide__prompt-tools-label">Tools it runs: </span>
                    {example.tools.map((tool, index) => (
                      <span key={tool}>
                        {index > 0 && ', '}
                        <code>{tool}</code>
                      </span>
                    ))}
                  </p>
                )}
                {example.gap && (
                  <GuideNote icon={AlertTriangle} title="Not available through the agent">
                    {example.gap.limitation} {example.gap.instead}
                  </GuideNote>
                )}
              </article>
            ))}
          </div>
          <GuideNote icon={AlertTriangle} title="Images: planned, not permanent">
            A server-side SVG export is a planned future phase of this demo. Until it ships, treat
            an image as something the editor produces and you save &mdash; not something the agent
            can hand you.
          </GuideNote>
        </section>

        <section className="guide__section" aria-labelledby="catalogue-title">
          <h2 className="guide__section-title" id="catalogue-title">
            The full tool catalogue
          </h2>
          <p className="guide__text">
            Sixteen tools, so you know the surface before you connect. Every one of them acts only
            on diagrams you own.
          </p>
          <dl className="guide__catalogue">
            {TOOL_GROUPS.map((group) => (
              <div className="guide__catalogue-group" key={group.title}>
                <dt className="guide__catalogue-title">{group.title}</dt>
                <dd className="guide__catalogue-body">
                  <p className="guide__catalogue-tools">
                    {group.tools.map((tool, index) => (
                      <span key={tool}>
                        {index > 0 && ' '}
                        <code>{tool}</code>
                      </span>
                    ))}
                  </p>
                  <p className="guide__catalogue-note">{group.note}</p>
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="landing__cta-banner" aria-labelledby="guide-cta-title">
          <div>
            <h2 className="landing__cta-banner-title" id="guide-cta-title">
              Ready to watch an agent draw?
            </h2>
            <p className="landing__cta-banner-text">
              Open a diagram in the editor, leave the tab visible, and give your agent its first
              instruction.
            </p>
          </div>
          <div className="landing__cta-banner-actions">
            <a className="button button--primary" href="/app">
              Open the editor
            </a>
            <a className="button" href="/blueprints">
              Browse blueprints
            </a>
          </div>
        </section>
      </main>
    </div>
  );
}
