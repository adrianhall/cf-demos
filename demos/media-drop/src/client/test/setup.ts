/** Minimal browser API implementation required by Vuetify's layout components in jsdom. */
class ResizeObserverStub implements ResizeObserver {
  /** Stop observing all elements. */
  disconnect(): void {}

  /** Start observing an element. */
  observe(): void {}

  /** Stop observing an element. */
  unobserve(): void {}
}

globalThis.ResizeObserver = ResizeObserverStub;
