import type { ReactNode } from 'react';
import './styles.css';

/**
 * Document metadata for every page in the explorer.
 */
export const metadata = {
  title: 'SWAPI Explorer',
  description:
    'A read-only explorer for the Star Wars dataset, backed by Cloudflare Access, Workers, D1, '
    + 'and GraphQL.'
};

/**
 * Shared document layout for the Star Wars explorer.
 *
 * Deliberately minimal, and a server component. Everything with behaviour lives below
 * `app/[[...explorer]]/page.tsx` in client components, because the explorer's entire purpose is to
 * demonstrate a browser talking to the GraphQL API — so this shell renders the document and nothing
 * else. It carries no header of its own: the explorer's banner is part of the three-column
 * application shell (UISPEC §3) and has to sit inside the layout that sizes those columns.
 *
 * @param props Server-rendered page content.
 * @returns The HTML document containing the requested page.
 */
export default function RootLayout({ children }: Readonly<{ children: ReactNode }>): ReactNode {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
