/**
 * @file The single Markdown-to-HTML boundary for the SPA. Every caller renders note Markdown
 *   through {@link renderMarkdown} here; nothing else imports the renderer.
 *
 *   ## Why the renderer is loaded lazily
 *
 *   `marked` and `dompurify` are the two largest dependencies used by only some views: the note
 *   page, the composer preview, and context note feeds. Bundling them into the main chunk made
 *   every first page load pay for them (and tipped the main chunk past Vite's 500 kB warning). The
 *   implementation therefore lives in `./markdown-renderer.ts` and is fetched with a dynamic
 *   `import()` the first time any view renders Markdown; the bundler emits it as its own chunk. The
 *   promise is cached, so the chunk is requested at most once per page load, and a failed load is
 *   forgotten so a later render can retry. The security rules (HTML disabled, unsafe URLs removed,
 *   DOMPurify as the final allowlist) are unchanged and documented in the renderer module; lazy
 *   loading changes only _when_ that code arrives, never what it does.
 */

/**
 * The renderer module's shape.
 */
type RendererModule = typeof import('./markdown-renderer.ts');

/**
 * The in-flight or completed renderer load, shared by every caller.
 */
let loading: Promise<RendererModule> | null = null;

/**
 * Load the renderer chunk once.
 *
 * @returns The renderer module.
 * @throws {Error} When the chunk cannot be fetched (for example, offline after a deploy); the cache
 *   is cleared so the next call retries.
 */
export function loadMarkdownRenderer(): Promise<RendererModule> {
  loading ??= import('./markdown-renderer.ts').catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

/**
 * Render untrusted note Markdown to sanitised HTML that is safe for `v-html`.
 *
 * @param source Raw Markdown.
 * @returns Once the renderer chunk has loaded, the sanitised HTML.
 * @throws {Error} When the renderer chunk cannot be loaded.
 */
export async function renderMarkdown(source: string): Promise<string> {
  const renderer = await loadMarkdownRenderer();
  return renderer.renderMarkdown(source);
}
