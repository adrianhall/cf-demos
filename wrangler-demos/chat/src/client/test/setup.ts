/** Minimal ResizeObserver implementation for Vuetify components in jsdom. */
class ResizeObserverStub implements ResizeObserver {
  /** Stop observing every element. */
  disconnect(): void {}

  /** Start observing an element. */
  observe(): void {}

  /** Stop observing an element. */
  unobserve(): void {}
}

globalThis.ResizeObserver = ResizeObserverStub;
