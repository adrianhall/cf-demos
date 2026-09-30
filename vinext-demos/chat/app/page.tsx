import { ChatWorkspace } from '../src/ui/chat-workspace';

/**
 * Render the shared chat workspace at the application root.
 *
 * Like the sibling `todo` demo and unlike `link`, the root here is deliberately **not** public.
 * This application has no anonymous surface at all — attributing messages to people is the whole
 * subject of the demo — so `/` is protected directly by the Cloudflare Access application covering
 * the whole hostname (`infra/access.tf`), and by the matching page policy in
 * `src/access-policies.ts` during local development. A visitor is therefore challenged by Access
 * before this component ever renders, which is why there is no public landing page linking onward
 * to a protected route.
 *
 * @returns The chat workspace page.
 */
export default function HomePage(): React.JSX.Element {
  return <ChatWorkspace />;
}
