import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, expect, it, vi } from 'vitest';
import TemplatesView from '../src/views/TemplatesView.vue';
vi.mock('../src/api/client', () => ({
  api: vi.fn(async () => ({
    templates: [
      { id: 'letter', name: 'Letter', manifest: { version: 1, shape: null } },
    ],
  })),
}));
afterEach(() => vi.restoreAllMocks());
it('shows a filling top-centered lazy preview linked to generation and falls back on image failure', async () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: TemplatesView },
      {
        path: '/:pathMatch(.*)*',
        component: { template: '<p>Destination</p>' },
      },
    ],
  });
  await router.push('/');
  const wrapper = mount(TemplatesView, { global: { plugins: [router] } });
  await flushPromises();
  const image = wrapper.get('img');
  expect(image.attributes('src')).toBe('/api/templates/letter/preview');
  expect(image.attributes('loading')).toBe('lazy');
  expect(image.classes()).toContain('object-cover');
  expect(image.classes()).toContain('object-top');
  expect(image.element.closest('a')?.getAttribute('href')).toBe(
    '/templates/letter/generate',
  );
  await image.trigger('error');
  expect(wrapper.text()).toContain('Preview unavailable');
  expect(wrapper.find('img').exists()).toBe(false);
  expect(wrapper.text()).toContain('Edit template');
  wrapper.unmount();
});
