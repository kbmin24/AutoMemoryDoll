import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory } from 'vue-router';
import { createAppRouter } from '../src/router';
import App from '../src/App.vue';
import { session } from '../src/api/client';

let wrapper: VueWrapper;
let calls: { path: string; init: RequestInit }[];
let shape: unknown;
let failSave = false;
const field = {
  variable: 'name',
  label: 'Name',
  type: 'text',
  optional: false,
};
const template = () => ({
  id: 'letter',
  name: 'Letter',
  manifest: { version: 1, shape },
});
beforeEach(() => {
  calls = [];
  shape = { fields: [field] };
  failSave = false;
  session.user = null;
  vi.stubGlobal(
    'confirm',
    vi.fn(() => false),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init: RequestInit = {}) => {
      calls.push({ path, init });
      let data: unknown = {};
      let status = 200;
      if (path === '/api/auth/me')
        data = {
          user: { id: 'self', username: 'reader', role: 'user' },
          csrfToken: 'csrf',
        };
      else if (path === '/api/templates' && init.method === 'POST')
        data = { template: template() };
      else if (path === '/api/templates') data = { templates: [template()] };
      else if (path === '/api/templates/letter')
        data = { template: template() };
      else if (path.endsWith('/files') && init.method === 'GET')
        data = {
          files: [
            { name: 'template.tex', kind: 'file', segments: ['template.tex'] },
            { name: 'logo.png', kind: 'file', segments: ['logo.png'] },
            { name: 'parts', kind: 'directory', segments: ['parts'] },
          ],
        };
      else if (path.includes('/text?')) {
        if (path.includes('logo.png')) {
          status = 400;
          data = { error: 'Not an editable text file' };
        } else data = { text: 'Hello' };
      } else if (failSave) {
        status = 400;
        data = { error: 'Storage limit exceeded' };
      } else
        status =
          path.endsWith('/directories') || path.endsWith('/uploads')
            ? 201
            : 204;
      return new Response(
        status === 204 || status === 201 ? null : JSON.stringify(data),
        {
          status,
        },
      );
    }),
  );
});
afterEach(() => {
  wrapper?.unmount();
  vi.unstubAllGlobals();
});
async function open(path = '/templates/letter/edit') {
  const router = createAppRouter(createMemoryHistory());
  await router.push(path);
  wrapper = mount(App, { global: { plugins: [router] } });
  await flushPromises();
  return router;
}
async function click(text: string) {
  const button = wrapper.findAll('button').find((item) => item.text() === text);
  expect(button, text).toBeTruthy();
  await button!.trigger('click');
  await flushPromises();
}
function mutation(method: string, suffix: string) {
  return calls.find(
    (call) => call.init.method === method && call.path.endsWith(suffix),
  );
}
it('creates with an enabled shape and requires one valid field', async () => {
  await open('/templates/new');
  expect(
    wrapper.get<HTMLInputElement>('[aria-label="Define data shape"]').element
      .checked,
  ).toBe(true);
  await wrapper.get('[aria-label="Template name"]').setValue('Letter');
  await wrapper.get('form').trigger('submit');
  expect(mutation('POST', '/api/templates')).toBeUndefined();
  await wrapper.get('[aria-label="Variable 1"]').setValue('name');
  await wrapper.get('[aria-label="Display name 1"]').setValue('Name');
  await wrapper.get('form').trigger('submit');
  await flushPromises();
  expect(
    JSON.parse(String(mutation('POST', '/api/templates')!.init.body)),
  ).toEqual({
    name: 'Letter',
    manifest: { version: 1, shape: { fields: [field] } },
  });
});
it('creates with shape explicitly off', async () => {
  await open('/templates/new');
  await wrapper.get('[aria-label="Template name"]').setValue('Letter');
  await wrapper.get('[aria-label="Define data shape"]').setValue(false);
  await wrapper.get('form').trigger('submit');
  await flushPromises();
  expect(
    JSON.parse(String(mutation('POST', '/api/templates')!.init.body)).manifest
      .shape,
  ).toBeNull();
});
it('renames a template', async () => {
  await open();
  await wrapper.get('[aria-label="Template name"]').setValue('Renamed');
  await wrapper.get('[aria-label="Template settings"]').trigger('submit');
  await flushPromises();
  expect(JSON.parse(String(mutation('PATCH', '/letter')!.init.body))).toEqual({
    name: 'Renamed',
  });
});
it('edits text, inserts a validated resource token, and reports failed saves', async () => {
  await open();
  await click('template.tex');
  await wrapper.get('[aria-label="Resource alias"]').setValue('../bad');
  await click('Insert resource');
  expect(wrapper.text()).toContain('Invalid resource alias');
  await wrapper.get('[aria-label="Resource alias"]').setValue('logo');
  await click('Insert resource');
  await click('Save file');
  expect(
    JSON.parse(String(mutation('PUT', '/text')!.init.body)).text,
  ).toContain('@resource(logo)');
  await wrapper.get('[aria-label="File content"]').setValue('changed');
  failSave = true;
  await click('Save file');
  expect(wrapper.text()).toContain('Storage limit exceeded');
  expect(wrapper.text()).toContain('Unsaved changes');
});
it('protects template.tex and offers download rather than editing rejected binary content', async () => {
  await open();
  await click('template.tex');
  expect(
    wrapper.get('[aria-label="Rename selected"]').attributes('disabled'),
  ).toBeDefined();
  expect(
    wrapper.get('[aria-label="Move selected"]').attributes('disabled'),
  ).toBeDefined();
  expect(
    wrapper.get('[aria-label="Delete selected"]').attributes('disabled'),
  ).toBeDefined();
  await click('logo.png');
  expect(wrapper.find('[aria-label="File content"]').exists()).toBe(false);
  expect(wrapper.get('.workspace-panes').attributes('data-pane')).toBe(
    'editor',
  );
  expect(wrapper.get('a[download]').attributes('href')).toContain(
    'segments=logo.png',
  );
});
it('warns before discarding edits when selecting a file or leaving', async () => {
  const router = await open();
  await click('template.tex');
  await wrapper.get('[aria-label="File content"]').setValue('unsaved');
  await click('logo.png');
  expect(
    wrapper.get<HTMLTextAreaElement>('[aria-label="File content"]').element
      .value,
  ).toBe('unsaved');
  await router.push('/templates');
  expect(router.currentRoute.value.path).toBe('/templates/letter/edit');
  expect(window.confirm).toHaveBeenCalled();
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
});
it('creates files and folders, renames, moves, deletes with confirmation, and uploads multipart', async () => {
  await open();
  await wrapper.get('[aria-label="Destination path"]').setValue('notes.tex');
  await click('Create file');
  expect(JSON.parse(String(mutation('PUT', '/text')!.init.body))).toEqual({
    segments: ['notes.tex'],
    text: '',
  });
  await wrapper.get('[aria-label="Destination path"]').setValue('assets');
  await click('Create folder');
  expect(wrapper.text()).toContain('Workspace updated.');
  expect(
    JSON.parse(String(mutation('POST', '/directories')!.init.body)),
  ).toEqual({ segments: ['assets'] });
  await click('logo.png');
  await wrapper.get('[aria-label="Destination path"]').setValue('brand.png');
  await click('Rename');
  expect(JSON.parse(String(mutation('POST', '/move')!.init.body))).toEqual({
    from: ['logo.png'],
    to: ['brand.png'],
  });
  await click('logo.png');
  await wrapper
    .get('[aria-label="Destination path"]')
    .setValue('parts/logo.png');
  await click('Move');
  expect(calls.filter((c) => c.path.endsWith('/move')).at(-1)!.init.body).toBe(
    JSON.stringify({ from: ['logo.png'], to: ['parts', 'logo.png'] }),
  );
  await click('parts');
  vi.mocked(window.confirm).mockReturnValue(true);
  await click('Delete');
  expect(JSON.parse(String(mutation('DELETE', '/files')!.init.body))).toEqual({
    segments: ['parts'],
  });
  const input = wrapper.get('input[type="file"]');
  Object.defineProperty(input.element, 'files', {
    value: [new File(['png'], 'new.png')],
  });
  await input.trigger('change');
  await wrapper.get('[aria-label="Destination path"]').setValue('new.png');
  await click('Upload');
  expect(wrapper.text()).toContain('Workspace updated.');
  const upload = mutation('POST', '/uploads')!;
  expect(upload.init.body).toBeInstanceOf(FormData);
  expect((upload.init.body as FormData).get('segments')).toBe('["new.png"]');
  expect(upload.init.headers).toEqual({ 'X-CSRF-Token': 'csrf' });
});
it('validates unique variables and supports type, optional, reorder and remove controls', async () => {
  await open();
  await click('Data shape');
  await click('Add field');
  await wrapper.get('[aria-label="Variable 2"]').setValue('name');
  await wrapper.get('[aria-label="Display name 2"]').setValue('Second');
  await click('Save shape');
  expect(mutation('PATCH', '/letter')).toBeUndefined();
  await wrapper.get('[aria-label="Variable 2"]').setValue('notes');
  await wrapper.get('[aria-label="Type 2"]').setValue('longtext');
  await wrapper.get('[aria-label="Optional 2"]').setValue(true);
  await wrapper.get('[aria-label="Move field 2 up"]').trigger('click');
  await click('Save shape');
  const saved = JSON.parse(String(mutation('PATCH', '/letter')!.init.body))
    .manifest.shape.fields;
  expect(saved[0]).toEqual({
    variable: 'notes',
    label: 'Second',
    type: 'longtext',
    optional: true,
  });
  await wrapper.get('[aria-label="Remove field 2"]').trigger('click');
  expect(wrapper.findAll('[aria-label^="Variable "]')).toHaveLength(1);
});

it('ignores a delayed response for a previously selected template', async () => {
  const router = await open();
  const originalFetch = fetch;
  let resolveOld!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: RequestInit) => {
      if (path === '/api/templates/old')
        return new Promise<Response>((resolve) => {
          resolveOld = resolve;
        });
      if (path === '/api/templates/newer')
        return Promise.resolve(
          new Response(
            JSON.stringify({
              template: { ...template(), id: 'newer', name: 'Newer' },
            }),
          ),
        );
      return originalFetch(path, init);
    }),
  );
  await router.push('/templates/old/edit');
  await flushPromises();
  await router.push('/templates/newer/edit');
  await flushPromises();
  expect(
    wrapper.get<HTMLInputElement>('[aria-label="Template name"]').element.value,
  ).toBe('Newer');
  resolveOld(
    new Response(
      JSON.stringify({ template: { ...template(), id: 'old', name: 'Old' } }),
    ),
  );
  await flushPromises();
  expect(
    wrapper.get<HTMLInputElement>('[aria-label="Template name"]').element.value,
  ).toBe('Newer');
});
it('shows the download pane when a binary file is selected first on mobile', async () => {
  await open();
  await click('logo.png');
  expect(wrapper.get('.workspace-panes').attributes('data-pane')).toBe(
    'editor',
  );
});
