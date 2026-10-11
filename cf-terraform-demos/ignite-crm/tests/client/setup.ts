/**
 * @file DOM test setup.
 */

/**
 * Minimal `ResizeObserver` for Vuetify components in jsdom, which does not implement it. jsdom
 * reports zero sizes anyway, so there is nothing to observe.
 */
class ResizeObserverStub implements ResizeObserver {
  /**
   * Stop observing everything.
   */
  disconnect(): void {}

  /**
   * Start observing an element.
   */
  observe(): void {}

  /**
   * Stop observing an element.
   */
  unobserve(): void {}
}

globalThis.ResizeObserver = ResizeObserverStub;

/**
 * `matchMedia` for Vuetify's display and `system` theme detection.
 *
 * @param query Media query.
 * @returns A never-matching list.
 */
globalThis.matchMedia ??= (query: string): MediaQueryList =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false
  }) as MediaQueryList;

/**
 * `visualViewport` for Vuetify overlays (dialogs, menus) positioning against the viewport.
 */
globalThis.visualViewport ??= Object.assign(new EventTarget(), {
  width: 1024,
  height: 768,
  offsetLeft: 0,
  offsetTop: 0,
  pageLeft: 0,
  pageTop: 0,
  scale: 1,
  onresize: null,
  onscroll: null,
  onscrollend: null
}) as unknown as VisualViewport;
