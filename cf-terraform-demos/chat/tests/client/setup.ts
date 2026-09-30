/**
 * Minimal `ResizeObserver` implementation for Vuetify components in jsdom.
 *
 * Several Vuetify components observe their own size on mount. jsdom does not implement
 * `ResizeObserver`, so without this stub those components throw during mounting and every component
 * test fails for a reason unrelated to what it is testing. The stub does nothing deliberately —
 * jsdom reports zero-size elements anyway, so there is no resize to report.
 */
class ResizeObserverStub implements ResizeObserver {
  /**
   * Stop observing every element.
   */
  disconnect(): void {}

  /**
   * Start observing an element.
   */
  observe(): void {}

  /**
   * Stop observing one element.
   */
  unobserve(): void {}
}

globalThis.ResizeObserver = ResizeObserverStub;
