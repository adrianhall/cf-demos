import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import App from '../../src/client/App.vue';

describe('App', () => {
  it('renders the routed page inside the application shell', () => {
    const wrapper = mount(App, {
      global: {
        stubs: {
          RouterView: {
            template: '<div data-testid="router-view">Routed page</div>'
          },
          VApp: {
            template: '<div data-testid="app-shell"><slot /></div>'
          },
          VMain: {
            template: '<main><slot /></main>'
          }
        }
      }
    });

    expect(wrapper.get('[data-testid="app-shell"] main').element.tagName).toBe('MAIN');
    expect(wrapper.get('[data-testid="router-view"]').text()).toBe('Routed page');
  });
});
