/** Minimal ResizeObserver implementation for Vuetify and Vue Flow in jsdom. */
class ResizeObserverStub implements ResizeObserver {
  /** Stop observing elements. */
  disconnect(): void {}
  /** Observe an element. */
  observe(): void {}
  /** Stop observing an element. */
  unobserve(): void {}
}

globalThis.ResizeObserver = ResizeObserverStub;
