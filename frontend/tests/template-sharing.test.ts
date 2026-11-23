import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory } from 'vue-router';
import App from '../src/App.vue';
import { clearSession } from '../src/api/client';
import { createAppRouter } from '../src/router';

const shares = '/api/templates/owned/shares';
const recipient = { id: 'reader', username: 'ReaderName' };
let wrapper: VueWrapper;
let fetchApi: ReturnType<typeof vi.fn>;
let recipients: (typeof recipient)[];

beforeEach(() => {
  clearSession();
  recipients = [];
  vi.stubGlobal(
    'fetch',
    (fetchApi = vi.fn(async (path: string, init: RequestInit) => {
      const json = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), { status });
      if (path === '/api/auth/me')
        return json({
          user: {
            id: 'owner',
            username: 'Owner',
            role: 'user',
            disabled: false,
          },
          csrfToken: 'csrf',
        });
      if (path === '/api/templates')
        return json({
          templates: [
            {
              id: 'owned',
              name: 'Owned letter',
              manifest: { version: 1, shape: null },
            },
          ],
          sharedTemplates: [{ id: 'invited', name: 'Shared letter' }],
        });
      if (path === '/api/templates/owned/view')
        return json({
          template: {
            id: 'owned',
            name: 'Owned letter',
            manifest: { version: 1, shape: null },
          },
        });
      if (path === '/api/templates/owned/files') return json({ files: [] });
      if (path === '/api/auth/ai-status') return json({ enabled: false });
      if (path === shares && init.method === 'GET')
        return json({ recipients });
      if (path === shares && init.method === 'POST') {
        if (JSON.parse(String(init.body)).username !== recipient.username)
          return json({ error: 'Recipient not found' }, 404);
        recipients.push(recipient);
        return json(recipient);
      }
      if (path === `${shares}/reader` && init.method === 'DELETE') {
        recipients = [];
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request to ${path}`);
    })),
  );
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute('open', '');
      },
    },
    close: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.removeAttribute('open');
        this.dispatchEvent(new Event('close'));
      },
    },
  });
});

afterEach(() => {
  wrapper?.unmount();
  vi.unstubAllGlobals();
  clearSession();
});

async function openTemplates(path = '/templates') {
  const router = createAppRouter(createMemoryHistory());
  await router.push(path);
  wrapper = mount(App, { global: { plugins: [router] } });
  await flushPromises();
}

it('switches between owned and shared cards with pointer and keyboard navigation', async () => {
  await openTemplates();
  const owned = wrapper.get('[role="tab"]#owned-templates-tab');
  const shared = wrapper.get('[role="tab"]#shared-templates-tab');
  expect(owned.attributes('aria-selected')).toBe('true');
  expect(wrapper.get('.template-card').text()).toContain('Owned letter');
  expect(wrapper.find('a[href="/templates/invited/generate"]').exists()).toBe(
    false,
  );

  await shared.trigger('click');
  expect(shared.attributes('aria-selected')).toBe('true');
  const card = wrapper.get('#shared-templates-panel .template-card');
  expect(card.text()).toContain('Shared letter');
  expect(card.get('a').attributes('href')).toBe(
    '/templates/invited/generate',
  );
  const preview = card.get('img');
  expect(preview.attributes('src')).toBe('/api/templates/invited/preview');
  expect(card.find('button, a[href$="/edit"]').exists()).toBe(false);
  await preview.trigger('error');
  expect(card.text()).toContain('Preview unavailable');

  await shared.trigger('keydown', { key: 'ArrowLeft' });
  expect(owned.attributes('aria-selected')).toBe('true');
  expect(wrapper.get('.template-card').text()).toContain('Owned letter');
});

it('invites by exact username, shows errors, and removes a revoked recipient', async () => {
  await openTemplates('/templates/owned/edit');
  const settings = wrapper
    .findAll('button')
    .find((button) => button.text() === 'Settings');
  await settings!.trigger('click');
  await wrapper.get('[aria-label="Share Owned letter"]').trigger('click');
  await flushPromises();
  const dialog = wrapper.get('dialog[open]');
  expect(dialog.text()).toContain('No recipients yet.');
  const input = dialog.get('input');
  await input.setValue('readername');
  await dialog.get('form').trigger('submit');
  await flushPromises();
  expect(dialog.get('[role="alert"]').text()).toContain(
    'Recipient not found',
  );
  await input.setValue('ReaderName');
  await dialog.get('form').trigger('submit');
  await flushPromises();
  expect(fetchApi).toHaveBeenCalledWith(
    shares,
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ username: 'ReaderName' }),
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf' },
    }),
  );
  expect(dialog.text()).toContain('ReaderName');
  await dialog
    .get('[aria-label="Revoke access for ReaderName"]')
    .trigger('click');
  await flushPromises();
  expect(dialog.text()).toContain('No recipients yet.');
  expect(dialog.text()).not.toContain('ReaderName');
  await dialog.get('button[type="button"]:last-child').trigger('click');
  expect(wrapper.find('dialog[open]').exists()).toBe(false);
});
