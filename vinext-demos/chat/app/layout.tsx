import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { IdentityBadge } from '../src/ui/identity-badge';
import './styles.css';

/**
 * Document metadata for every page.
 *
 * Exported from the layout rather than set per page, because this application is a single
 * workspace: there is no second page that would want a different title.
 */
export const metadata: Metadata = {
  title: 'Chat',
  description: 'A real-time chat workspace on Cloudflare Workers, Access, D1, and Durable Objects.'
};

/**
 * Shared document layout for every page in the chat demo.
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
          <span className="app-name">Chat</span>
          <IdentityBadge />
          {/*
            A plain link to Cloudflare Access's own logout endpoint rather than any application
            state: the session lives in the Access cookie, so signing out is Access's job. Visible
            at all times because switching identity — to see the same channel as somebody else —
            is how this demo is shown.
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
