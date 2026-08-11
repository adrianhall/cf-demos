import {
  BookOpen,
  CheckCircle,
  Cpu,
  Download,
  type Icon,
  Eye,
  Grid,
  Layers,
  Layout,
  Lock,
  Share2,
  Terminal,
  Users,
} from "react-feather";
import { AppHeader } from "../components/AppHeader";
import { HeroDiagram } from "../components/landing/HeroDiagram";
import { useIdentity } from "../hooks/useIdentity";

/** Copy and icon for one of the hero's three supporting benefit cards. */
interface Benefit {
  icon: Icon;
  title: string;
  body: string;
}

const BENEFITS: Benefit[] = [
  {
    icon: Eye,
    title: "See your stack, not just your config",
    body: "A diagram communicates an architecture in seconds. Drop Workers, D1, R2, and every other Cloudflare product onto a canvas and connect them the way data actually flows.",
  },
  {
    icon: CheckCircle,
    title: "Every node is a real Cloudflare product",
    body: "The palette is a curated, always-current catalog — not a generic shapes library — so a diagram doubles as documentation someone can act on.",
  },
  {
    icon: Lock,
    title: "Share without handing out access",
    body: "A read-only share link renders a diagram with no sign-in required, while the diagram itself, and who can edit it, stays behind Cloudflare Access.",
  },
];

/** Copy and icon for one of the six product-capability cards. */
interface Feature {
  icon: Icon;
  title: string;
  body: string;
}

const FEATURES: Feature[] = [
  {
    icon: Layout,
    title: "Drag-and-drop canvas",
    body: "Place, connect, and auto-layout nodes on a React Flow canvas that autosaves as you work.",
  },
  {
    icon: Grid,
    title: "Curated product catalog",
    body: "Compute, storage, AI, media, network, and security products, each with its own icon, category color, and documentation links.",
  },
  {
    icon: Layers,
    title: "Blueprint gallery",
    body: "Start from a pre-built architecture pattern instead of a blank canvas, then customize it for your own design.",
  },
  {
    icon: Share2,
    title: "One-click sharing",
    body: "Generate a revocable, read-only link so anyone can view a diagram without an account or an Access login.",
  },
  {
    icon: Download,
    title: "Export anywhere",
    body: "Save a diagram as a PNG or SVG for a slide deck, or export it as a downloadable starter Wrangler project.",
  },
  {
    icon: Terminal,
    title: "Agent-ready via MCP",
    body: "A remote MCP server lets an AI agent read and edit your diagrams directly, with changes appearing live in any open tab.",
  },
];

/** Copy and icon for one of the four "who this is for" persona cards. */
interface UseCase {
  icon: Icon;
  title: string;
  body: string;
}

const USE_CASES: UseCase[] = [
  {
    icon: Users,
    title: "Solutions engineers",
    body: "Sketch a proposed architecture live on a call, then share a read-only link in the follow-up email.",
  },
  {
    icon: Cpu,
    title: "Platform teams",
    body: "Keep an accurate, always-editable diagram of production infrastructure instead of a stale slide someone drew once.",
  },
  {
    icon: BookOpen,
    title: "Educators & workshops",
    body: "Start from a blueprint that already illustrates a common pattern, and let students explore it interactively.",
  },
  {
    icon: Terminal,
    title: "AI agents & MCP clients",
    body: "Connect an MCP-compliant client and let an agent add, remove, or rearrange nodes on your behalf.",
  },
];

/**
 * Public landing page served for every path other than `/app*`, `/blueprints`, and `/s/:token`
 * (see `../App.tsx`). Requires no Cloudflare Access identity — Terraform's public `bypass`
 * Access application covers this whole hostname (`infra/access.tf`).
 *
 * GitLab issue #4: the previous version of this page was a single headline, a paragraph, and one
 * link, and did not read as a landing page for the product. This version keeps the same primary
 * call to action (`href="/app"`, "Open the editor") but makes it the hero section's obvious
 * focal point, adds a hero illustration built from the app's own real node/icon components (see
 * `../components/landing/HeroDiagram.tsx` for why that needed no new image asset), and adds
 * benefit, feature, and use-case sections that explain what the product actually does before
 * asking an anonymous visitor to sign in.
 *
 * Renders the same shared banner as every other "chrome" page (`../components/AppHeader.tsx`,
 * `current: "landing"`), in its `public` access mode, so a returning signed-in visitor sees
 * "Sign out" and a "My Diagrams" shortcut instead of only the hero's CTA.
 */
export function LandingView() {
  const identity = useIdentity();

  return (
    <div className="app-shell">
      <AppHeader identity={identity} current="landing" access="public" />
      <main className="app-shell__main landing">
        <section className="landing__hero">
          <div>
            <p className="landing__hero-eyebrow">
              Cloudflare architecture diagrams
            </p>
            <h1 className="landing__hero-title">
              Design your Cloudflare architecture, visually.
            </h1>
            <p className="landing__hero-subtitle">
              Drag real Cloudflare products onto a canvas, connect them the way
              your requests actually flow, and get a living diagram you can
              share, export, and hand off to an AI agent to keep up to date.
            </p>
            <div className="landing__hero-actions">
              <a className="button button--primary" href="/app">
                Open the editor
              </a>
              <a className="button" href="/blueprints">
                Browse blueprints
              </a>
            </div>
          </div>
          <HeroDiagram />
        </section>

        <section className="landing__section" aria-labelledby="benefits-title">
          <div className="landing__section-header">
            <h2 className="landing__section-title" id="benefits-title">
              Why teams diagram here
            </h2>
            <p className="landing__section-intro">
              A diagram editor built specifically around the Cloudflare
              Developer Platform, not a generic shapes tool pressed into
              service.
            </p>
          </div>
          <div className="landing__grid landing__grid--3">
            {BENEFITS.map((benefit) => (
              <article className="landing__card" key={benefit.title}>
                <benefit.icon
                  className="landing__card-icon"
                  size={28}
                  aria-hidden="true"
                />
                <h3 className="landing__card-title">{benefit.title}</h3>
                <p className="landing__card-body">{benefit.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="landing__section" aria-labelledby="features-title">
          <div className="landing__section-header">
            <h2 className="landing__section-title" id="features-title">
              Everything you need to document a stack
            </h2>
            <p className="landing__section-intro">
              From a blank canvas to a shareable, exportable diagram — no other
              tool required.
            </p>
          </div>
          <div className="landing__grid landing__grid--3">
            {FEATURES.map((feature) => (
              <article className="landing__card" key={feature.title}>
                <feature.icon
                  className="landing__card-icon"
                  size={28}
                  aria-hidden="true"
                />
                <h3 className="landing__card-title">{feature.title}</h3>
                <p className="landing__card-body">{feature.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="landing__section" aria-labelledby="use-cases-title">
          <div className="landing__section-header">
            <h2 className="landing__section-title" id="use-cases-title">
              Built for how you already work
            </h2>
          </div>
          <div className="landing__grid landing__grid--4">
            {USE_CASES.map((useCase) => (
              <article className="landing__card" key={useCase.title}>
                <useCase.icon
                  className="landing__card-icon"
                  size={24}
                  aria-hidden="true"
                />
                <h3 className="landing__card-title">{useCase.title}</h3>
                <p className="landing__card-body">{useCase.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="landing__cta-banner" aria-labelledby="cta-title">
          <div>
            <h2 className="landing__cta-banner-title" id="cta-title">
              Ready to see your architecture on a canvas?
            </h2>
            <p className="landing__cta-banner-text">
              Sign in with Cloudflare Access to start a diagram — no
              installation, and nothing to configure.
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
