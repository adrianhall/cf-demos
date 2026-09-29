import type { ReactNode } from 'react';
import './styles.css';

/**
 * Shared document layout for the Link administrative interface.
 *
 * @param props Server-rendered page content.
 * @returns The HTML document that contains the requested page.
 */
export default function RootLayout({ children }: Readonly<{ children: ReactNode }>): ReactNode {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
