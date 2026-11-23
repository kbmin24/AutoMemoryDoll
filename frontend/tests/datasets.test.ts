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
  let score = 0;
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
      if (path === '/api/datasets/roster/rows/one' && init.method === 'PATCH') {
        score = JSON.parse(String(init.body)).values.score;
        return Response.json({
          row: { id: 'one', position: 1, values: { score } },
        });
      }
      if (path === '/api/datasets/roster/rows') {
        const row = { id: 'one', position: 1, values: { score } };
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
  wrapper = mount(App, {
    attachTo: document.body,
    global: { plugins: [router] },
  });
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
  const rowsTab = wrapper.get('#dataset-tab-rows');
  const importTab = wrapper.get('#dataset-tab-import');
  const settingsTab = wrapper.get('#dataset-tab-settings');
  expect(rowsTab.attributes('aria-selected')).toBe('true');
  expect(wrapper.get('#dataset-panel-import').isVisible()).toBe(false);
  const settings = wrapper.get('#dataset-panel-settings');
  expect(settings.isVisible()).toBe(false);
  await rowsTab.trigger('keydown', { key: 'ArrowLeft' });
  expect(settingsTab.attributes('aria-selected')).toBe('true');
  expect(document.activeElement).toBe(settingsTab.element);
  expect(settings.isVisible()).toBe(true);
  await settings.get('.btn-error').trigger('click');
  expect(wrapper.get('[aria-label="Confirm deletion"]').text()).toContain(
    'Delete this dataset and its rows?',
  );
  await rowsTab.trigger('click');
  expect(wrapper.find('[aria-label="Confirm deletion"]').exists()).toBe(false);
  const addCell = wrapper.get('tbody tr:last-child td');
  expect(addCell.attributes('colspan')).toBe('4');
  expect(addCell.find('i.fa-solid.fa-plus').exists()).toBe(true);
  const add = addCell.get('button');
  expect(add.text()).toBe('Add new entry');
  await add.trigger('click');
  const newRow = () => wrapper!.get('tbody tr:last-child');
  const newField = newRow().get<HTMLInputElement>('input[aria-label="Score"]');
  expect(newField.element.value).toBe('');
  expect(document.activeElement).toBe(newField.element);
  await newField.setValue('12');
  await newRow().get('[aria-label="Cancel new row"]').trigger('click');
  expect(newRow().text()).toBe('Add new entry');
  await newRow().get('button').trigger('click');
  const reopenedField = newRow().get<HTMLInputElement>(
    'input[aria-label="Score"]',
  );
  expect(reopenedField.element.value).toBe('');
  await reopenedField.setValue('0');
  await newRow().get('button[type="submit"]').trigger('click');
  await flushPromises();
  const row = requests.find(
    ({ path, init }) => path.endsWith('/rows') && init.method === 'POST',
  )!;
  expect(JSON.parse(String(row.init.body))).toEqual({ values: { score: 0 } });
  expect(wrapper.get('tbody tr:first-child').text()).toContain('0');
  expect(wrapper.get('tbody tr:last-child').text()).toBe('Add new entry');

  const existingRow = wrapper.get('tbody tr:first-child');
  const edit = () =>
    existingRow.get('[aria-label="Edit row 1"]').trigger('click');
  await edit();
  const field = existingRow.get<HTMLInputElement>('input[aria-label="Score"]');
  expect(field.element.value).toBe('0');
  expect(document.activeElement).toBe(field.element);
  await field.setValue('12');
  await existingRow
    .get('button[aria-label="Cancel editing row 1"]')
    .trigger('click');
  expect(existingRow.get('td').text()).toBe('0');
  await edit();
  await existingRow.get('input').setValue('7');
  await existingRow.get('button[type="submit"]').trigger('click');
  await flushPromises();
  expect(existingRow.find('input').exists()).toBe(false);
  expect(existingRow.get('td').text()).toBe('7');

  await importTab.trigger('click');
  expect(wrapper.get('#dataset-panel-rows').isVisible()).toBe(false);
  const input = wrapper.get('#dataset-csv');
  expect(input.isVisible()).toBe(true);
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

it('reorders by dragging and numbers rows across pages', async () => {
  const dataset = { id: 'roster', name: 'Roster', columns: [] };
  const first = { id: 'one', position: 1, values: {} };
  const second = { id: 'two', position: 2, values: {} };
  const third = { id: 'three', position: 3, values: {} };
  const fourth = { id: 'four', position: 4, values: {} };
  const moves: { path: string; body: unknown }[] = [];
  let rows = [first, second, third, fourth];
  let finishFirstMove!: () => void;
  const firstMove = new Promise<void>((resolve) => {
    finishFirstMove = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init: RequestInit) => {
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
      if (path === '/api/datasets/roster') return Response.json({ dataset });
      if (path === '/api/datasets/roster/rows')
        return Response.json({ rows: rows.slice(0, 2), nextAfter: 'rankB' });
      if (path === '/api/datasets/roster/rows?after=rankB')
        return Response.json({ rows: rows.slice(2), nextAfter: null });
      if (path.endsWith('/order')) {
        moves.push({ path, body: JSON.parse(String(init.body)) });
        if (moves.length === 1) await firstMove;
        if (moves.length === 2)
          return Response.json(
            { error: 'Could not move row' },
            { status: 409 },
          );
        if (path.endsWith('/four/order')) {
          rows = [second, first, fourth, third];
          return Response.json({ row: fourth, rebalanced: true });
        }
        rows = [second, first, third, fourth];
        return Response.json({ row: second });
      }
      throw new Error(`Unexpected request ${path}`);
    }),
  );
  const router = createAppRouter(createMemoryHistory());
  await router.push('/datasets/roster');
  wrapper = mount(App, { global: { plugins: [router] } });
  await flushPromises();

  const drag = wrapper.get('[title="Drag row 2"]');
  const setDragImage = vi.fn();
  const sourceRow = wrapper.get('tbody tr:nth-child(2)');
  await drag.trigger('dragstart', {
    clientX: 12,
    clientY: 8,
    dataTransfer: { setData: vi.fn(), setDragImage },
  });
  expect(setDragImage).toHaveBeenCalledWith(sourceRow.element, 12, 8);
  expect(sourceRow.classes()).toContain('opacity-50');
  await wrapper.get('tbody tr:first-child').trigger('drop');
  expect(
    wrapper.get('[aria-label="Dataset rows"]').attributes('aria-busy'),
  ).toBe('true');
  expect(
    wrapper
      .find('[role="status"][aria-label="Moving row"] .loading-spinner')
      .exists(),
  ).toBe(true);
  finishFirstMove();
  await flushPromises();
  expect(wrapper.find('[aria-label="Moving row"]').exists()).toBe(false);
  expect(wrapper.text()).not.toContain('Row moved.');
  expect(moves[0]).toEqual({
    path: '/api/datasets/roster/rows/two/order',
    body: { beforeRowId: 'one' },
  });
  expect(wrapper.get('thead th').text()).toBe('#');
  expect(wrapper.findAll('tbody th').map((cell) => cell.text())).toEqual([
    '1',
    '2',
  ]);

  const pageButton = (label: string) =>
    wrapper!
      .get('nav[aria-label="Row pages"]')
      .findAll('button')
      .find((button) => button.text() === label)!;
  await pageButton('Next').trigger('click');
  await flushPromises();
  expect(wrapper.findAll('tbody th').map((cell) => cell.text())).toEqual([
    '3',
    '4',
  ]);
  const dragFourthUp = async () => {
    await wrapper!.get('[title="Drag row 4"]').trigger('dragstart');
    await wrapper!.get('tbody tr:first-child').trigger('drop');
    await flushPromises();
  };
  await dragFourthUp();
  expect(wrapper.get('[role="alert"]').text()).toContain('Could not move row');

  await dragFourthUp();
  expect(moves[2]).toEqual({
    path: '/api/datasets/roster/rows/four/order',
    body: { beforeRowId: 'three' },
  });
  expect(wrapper.get('nav[aria-label="Row pages"]').text()).toContain('Page 1');
  expect(wrapper.get('tbody tr:first-child th').text()).toBe('1');
});
