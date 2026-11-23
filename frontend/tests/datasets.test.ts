import { afterEach, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory } from 'vue-router';
import { createAppRouter } from '../src/router';
import App from '../src/App.vue';
import { clearSession } from '../src/api/client';

let wrapper: VueWrapper | undefined;
afterEach(() => {
  wrapper?.unmount();
  clearSession();
  vi.unstubAllGlobals();
});

it('creates a dataset, saves a typed row, and displays a CSV rejection', async () => {
  const requests: { path: string; init: RequestInit }[] = [];
  const dataset = {
    id: 'roster',
    name: 'Roster',
    columns: [{ id: 'score', label: 'Score', type: 'number', optional: false }],
  };
  let saved = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init: RequestInit) => {
      requests.push({ path, init });
      if (path === '/api/auth/me')
        return Response.json({
          user: {
            id: 'owner',
            username: 'reader',
            role: 'user',
            disabled: false,
          },
          csrfToken: 'csrf',
        });
      if (path === '/api/datasets' && init.method === 'GET')
        return Response.json({ datasets: [] });
      if (path === '/api/datasets' && init.method === 'POST')
        return Response.json({ dataset }, { status: 201 });
      if (path === '/api/datasets/roster') return Response.json({ dataset });
      if (path === '/api/datasets/roster/rows') {
        const row = { id: 'one', position: 1, values: { score: 0 } };
        if (init.method === 'POST') {
          saved = true;
          return Response.json({ row }, { status: 201 });
        }
        return Response.json({ rows: saved ? [row] : [], nextAfter: null });
      }
      if (path === '/api/datasets/roster/import')
        return Response.json(
          {
            error: 'CSV data row 2, column 1: Invalid number value',
          },
          { status: 400 },
        );
      throw new Error(`Unexpected request ${path}`);
    }),
  );
  const router = createAppRouter(createMemoryHistory());
  await router.push('/datasets');
  wrapper = mount(App, { global: { plugins: [router] } });
  await flushPromises();
  expect(wrapper.text()).toContain('No datasets');
  await router.push('/datasets/new');
  await flushPromises();
  await wrapper.get('#dataset-name').setValue('Roster');
  await wrapper.get('#column-label-0').setValue('Score');
  await wrapper.get('#column-type-0').setValue('number');
  await wrapper.get('#dataset-schema').trigger('submit');
  await flushPromises();
  expect(router.currentRoute.value.path).toBe('/datasets/roster');
  const addCell = wrapper.get('tbody tr:last-child td');
  expect(addCell.attributes('colspan')).toBe('3');
  expect(addCell.find('i.fa-solid.fa-plus').exists()).toBe(true);
  const add = addCell.get('button');
  expect(add.text()).toBe('Add new entry');
  await add.trigger('click');
  await wrapper.get('#dataset-cell-score').setValue('0');
  await wrapper.get('#dataset-row').trigger('submit');
  await flushPromises();
  const row = requests.find(
    ({ path, init }) => path.endsWith('/rows') && init.method === 'POST',
  )!;
  expect(JSON.parse(String(row.init.body))).toEqual({ values: { score: 0 } });
  expect(wrapper.get('tbody tr:first-child').text()).toContain('0');
  expect(wrapper.get('tbody tr:last-child').text()).toBe('Add new entry');

  const input = wrapper.get('#dataset-csv');
  Object.defineProperty(input.element, 'files', {
    value: [new File(['Score\nwrong'], 'rows.csv')],
  });
  await input.trigger('change');
  await wrapper.get('#dataset-import').trigger('submit');
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain(
    'CSV data row 2, column 1',
  );
});

it('shows the last modified date in the dataset list', async () => {
  const updatedAt = '2026-11-22T08:00:00.000Z';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      if (path === '/api/auth/me')
        return Response.json({
          user: {
            id: 'owner',
            username: 'reader',
            role: 'user',
            disabled: false,
          },
          csrfToken: 'csrf',
        });
      if (path === '/api/datasets')
        return Response.json({
          datasets: [{ id: 'roster', name: 'Roster', columns: [], updatedAt }],
        });
      throw new Error(`Unexpected request ${path}`);
    }),
  );
  const router = createAppRouter(createMemoryHistory());
  await router.push('/datasets');
  wrapper = mount(App, { global: { plugins: [router] } });
  await flushPromises();
  expect(wrapper.get('thead [aria-sort="descending"]').text()).toBe(
    'Last modified',
  );
  expect(wrapper.get('tbody time').attributes('datetime')).toBe(updatedAt);
  expect(wrapper.get('tbody a').attributes('href')).toBe('/datasets/roster');
});
