/**
 * @file Module declarations for single-file components.
 */

declare module '*.vue' {
  import type { DefineComponent } from 'vue';

  /**
   * A compiled Vue single-file component.
   */
  const component: DefineComponent<object, object, unknown>;
  export default component;
}
