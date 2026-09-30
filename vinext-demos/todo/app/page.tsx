import { TodoView } from '../src/ui/todo-view';

/**
 * Render the signed-in user's task list at the application root.
 *
 * Unlike the sibling `link` demo, the root here is deliberately **not** public. This application
 * has no anonymous surface at all — every task belongs to an identity — so `/` is protected
 * directly by the Cloudflare Access application covering the whole hostname (`infra/access.tf`),
 * and by the matching page policy in `src/access-policies.ts` during local development. A visitor
 * is therefore challenged by Access before this component ever renders, which is why there is no
 * public landing page linking onward to a protected route.
 *
 * @returns The task management page.
 */
export default function HomePage(): React.JSX.Element {
  return <TodoView />;
}
