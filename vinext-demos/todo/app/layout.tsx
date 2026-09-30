import type { ReactNode } from 'react';
import { IdentityBadge } from '../src/ui/identity-badge';
import './styles.css';

/**
 * Shared document layout for every page in the task demo.
 *
 * This stays a server component: only the identity indicator needs browser state, and it is
 * isolated in its own client component so the document shell itself ships no JavaScript.
 *
 * @param props Server-rendered page content.
 * @returns The HTML document containing the requested page.
 */
export default function RootLayout({ children }: Readonly<{ children: ReactNode }>): ReactNode {
  return (
    <html lang="en">
      <body>
        <header className="app-header">
          <span className="app-name">Tasks</span>
          <IdentityBadge />
          {/*
            A plain link to Cloudflare Access's own logout endpoint rather than any application
            state: the session lives in the Access cookie, so signing out is Access's job. Visible
            at all times because switching identity is the point of this demo.
          */}
          <a className="button secondary" href="/cdn-cgi/access/logout">
            Sign out
          </a>
        </header>
        {children}
      </body>
    </html>
  );
}
