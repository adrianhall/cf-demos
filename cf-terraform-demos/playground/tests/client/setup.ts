import { beforeEach } from 'vitest';

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

/**
 * The shell header target used by `PanelPage` to place a panel title and its info button.
 *
 * Most view tests mount one route view rather than the entire application shell, so without this
 * small stand-in every mount would warn that its Teleport target is absent and drop the title.
 * Clearing the body also removes a modal or title teleported by the preceding test, keeping each
 * assertion isolated from previous rendered content.
 */
beforeEach(() => {
  document.body.innerHTML = '<div id="panel-title-slot"></div>';
  document.body.removeAttribute('style');
});
