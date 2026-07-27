/** Pattern accepted for a browser-generated, opaque anonymous viewer identifier. */
const viewerIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * Identify an unauthenticated public request without collecting personal information.
 *
 * @param request Public request containing the optional opaque `viewer` query parameter.
 * @returns A stable `anonymous:<id>` log value for valid browser identifiers.
 */
export function anonymousViewer(request: Request): string {
  const viewerId = new URL(request.url).searchParams.get("viewer");
  return viewerId !== null && viewerIdPattern.test(viewerId)
    ? `anonymous:${viewerId}`
    : "anonymous:unknown";
}
