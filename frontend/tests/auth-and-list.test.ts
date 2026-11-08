import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory } from 'vue-router';
import App from '../src/App.vue';
import { createAppRouter } from '../src/router';
import { api, session } from '../src/api/client';
import type { Role } from '../src/api/types';

let wrapper: VueWrapper | undefined;
let role: Role = 'user';
let loggedIn = true;
let loginFails = false;
let templatesFail = false;
let calls: { path: string; init: RequestInit }[];
const user = () => ({ id: 'self', username: 'reader', role, disabled: false });
const member = {
  id: 'member',
  username: 'writer',
  role: 'user',
  disabled: false,
};

beforeEach(() => {
  role = 'user';
  loggedIn = true;
  loginFails = false;
  templatesFail = false;
  session.user = null;
  session.csrfToken = null;
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init: RequestInit = {}) => {
      calls.push({ path, init });
      let status = 200;
      let data: unknown = {};
      if (path === '/api/auth/me' || path === '/api/auth/login') {
        status = (path.endsWith('/me') ? !loggedIn : loginFails) ? 401 : 200;
        data =
          status === 401
            ? { error: 'Invalid credentials' }
            : { user: user(), csrfToken: 'csrf' };
      } else if (path === '/api/templates') {
        status = templatesFail ? 500 : 200;
        data = templatesFail
          ? { error: 'Could not load templates' }
          : {
              templates: [
                {
                  id: 'letter',
                  name: 'Private letter',
                  manifest: { version: 1, shape: null },
                },
              ],
            };
      } else if (path === '/api/admin/users' && init.method === 'GET') {
        data = { users: [{ ...user(), role: 'owner' }, member] };
      } else if (path.endsWith('/role')) {
        data = {
          user: { ...member, role: JSON.parse(String(init.body)).role },
        };
      } else if (path === '/api/admin/users/member') {
        data = {
          user: { ...member, disabled: JSON.parse(String(init.body)).disabled },
        };
      } else if (path === '/api/admin/users') {
        data = { user: { ...member, id: 'new', username: 'newwriter' } };
      } else if (path === '/api/auth/password') {
        data = { message: 'Password changed' };
      } else {
        status = 204;
      }
      return new Response(status === 204 ? null : JSON.stringify(data), {
        status,
      });
    }),
  );
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function open(path = '/templates') {
  const router = createAppRouter(createMemoryHistory());
  await router.push(path);
  await router.isReady();
  wrapper = mount(App, {
    attachTo: document.body,
    global: { plugins: [router] },
  });
  await flushPromises();
  return router;
}
async function submit() {
  await wrapper!.get('form').trigger('submit');
  await flushPromises();
}
function accountButton() {
  return wrapper!.get('button[aria-controls="account-menu"]');
}

function button(text: string) {
  return wrapper!.findAll('button').find((item) => item.text() === text)!;
}

describe('authentication and private templates', () => {
  it('links the logo to the home route with an accessible name', async () => {
    const router = await open('/account');
    const logo = wrapper!.get('a.brand[href="/"]');
    expect(logo.get('img').attributes('alt')).toBe('AutoMemoryDoll');
    await logo.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/templates');
  });
  it('restores the session with credentials and renders only returned templates', async () => {
    await open();
    expect(wrapper!.text()).toContain('Private letter');
    expect(wrapper!.findAll('.template-card')).toHaveLength(1);
    expect(wrapper!.get('.template-card').text()).toContain(
      'Preview unavailable',
    );
    expect(wrapper!.get('header nav').text()).toContain('Templates');
    expect(
      calls.find((call) => call.path === '/api/auth/me')!.init.credentials,
    ).toBe('include');
  });
  it('redirects guests and shows a failed login before successful login', async () => {
    loggedIn = false;
    const router = await open();
    expect(router.currentRoute.value.path).toBe('/login');
    await wrapper!.get('#username').setValue('reader');
    await wrapper!.get('#password').setValue('correct-password');
    loginFails = true;
    await submit();
    expect(wrapper!.get('[role="alert"]').text()).toContain(
      'Invalid credentials',
    );
    loginFails = false;
    await submit();
    expect(router.currentRoute.value.path).toBe('/templates');
  });
  it('logs out with CSRF and clears private content', async () => {
    const router = await open();
    await accountButton().trigger('click');
    await button('Log out').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/login');
    expect(session.user).toBeNull();
    expect(
      calls.find((call) => call.path.endsWith('/logout'))!.init.headers,
    ).toMatchObject({ 'X-CSRF-Token': 'csrf' });
    expect(wrapper!.text()).not.toContain('Private letter');
  });
  it('opens account actions from the icon and closes on navigation', async () => {
    const router = await open();
    expect(wrapper!.find('nav a[href="/account"]').exists()).toBe(false);
    expect(wrapper!.find('a[href="/account"]').exists()).toBe(false);
    expect(button('Log out')).toBeUndefined();
    await accountButton().trigger('click');
    expect(accountButton().attributes('aria-expanded')).toBe('true');
    expect(accountButton().attributes('aria-label')).toBe('Account menu');
    expect(accountButton().find('.fa-regular.fa-user').exists()).toBe(true);
    expect(accountButton().text()).toBe('');
    expect(wrapper!.get('#account-menu > :first-child').text()).toBe('reader');
    expect(
      wrapper!.find('#account-menu > .account-username + hr').exists(),
    ).toBe(true);
    expect(wrapper!.get('a[href="/account"]').text()).toBe('My Account');
    await wrapper!.get('a[href="/account"]').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/account');
    expect(wrapper!.find('#account-menu').exists()).toBe(false);
  });
  it('dismisses account actions with Escape, outside click, or the username', async () => {
    await open();
    await accountButton().trigger('click');
    await accountButton().trigger('keydown', { key: 'Escape' });
    expect(accountButton().attributes('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(accountButton().element);
    await accountButton().trigger('click');
    await wrapper!.get('main').trigger('click');
    expect(wrapper!.find('#account-menu').exists()).toBe(false);
    await accountButton().trigger('click');
    await accountButton().trigger('click');
    expect(wrapper!.find('#account-menu').exists()).toBe(false);
    await accountButton().trigger('click');
    await accountButton().trigger('focusout', {
      relatedTarget: wrapper!.get('main').element,
    });
    expect(wrapper!.find('#account-menu').exists()).toBe(false);
  });
  it('changes the password and requires login again', async () => {
    const router = await open('/account');
    await wrapper!.get('#current-password').setValue('current-password');
    await wrapper!.get('#new-password').setValue('replacement-password');
    await submit();
    expect(
      JSON.parse(
        String(
          calls.find((call) => call.path.endsWith('/password'))!.init.body,
        ),
      ),
    ).toEqual({
      currentPassword: 'current-password',
      newPassword: 'replacement-password',
    });
    expect(router.currentRoute.value.path).toBe('/login');
    expect(wrapper!.text()).toContain('Password changed');
  });
  it('keeps the session and shows the error for an incorrect current password', async () => {
    const router = await open('/account');
    const originalFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string, init?: RequestInit) => {
        if (path === '/api/auth/password') {
          return Promise.resolve(
            new Response(
              JSON.stringify({ error: 'Current password is incorrect' }),
              { status: 401 },
            ),
          );
        }
        return originalFetch(path, init);
      }),
    );
    await wrapper!.get('#current-password').setValue('wrong-password');
    await wrapper!.get('#new-password').setValue('replacement-password');
    await submit();
    expect(router.currentRoute.value.path).toBe('/account');
    expect(session.user?.username).toBe('reader');
    expect(wrapper!.get('[role="alert"]').text()).toContain(
      'Current password is incorrect',
    );
  });
  it('confirms deletion before removing the returned template', async () => {
    await open();
    await button('Delete').trigger('click');
    expect(calls.some((call) => call.init.method === 'DELETE')).toBe(false);
    await button('Cancel').trigger('click');
    expect(wrapper!.find('[aria-label="Confirm deletion"]').exists()).toBe(
      false,
    );
    expect(wrapper!.findAll('.template-card')).toHaveLength(1);
    await button('Delete').trigger('click');
    await button('Delete template').trigger('click');
    await flushPromises();
    expect(wrapper!.text()).not.toContain('Private letter');
    expect(wrapper!.text()).toContain('No templates yet');
  });
  it('shows list errors without claiming an empty list', async () => {
    templatesFail = true;
    await open();
    expect(wrapper!.get('[role="alert"]').text()).toContain(
      'Could not load templates',
    );
    expect(wrapper!.text()).not.toContain('No templates yet');
  });
  it('clears expired sessions and redirects to login', async () => {
    const router = await open();
    loggedIn = false;
    await expect(api('/api/auth/me')).rejects.toThrow();
    await flushPromises();
    expect(session.user).toBeNull();
    expect(router.currentRoute.value.path).toBe('/login');
  });
});

describe('administration', () => {
  it('blocks the admin route and navigation for regular users', async () => {
    const router = await open('/admin/users');
    expect(router.currentRoute.value.path).toBe('/templates');
    expect(wrapper!.find('a[href="/admin/users"]').exists()).toBe(false);
    expect(calls.some((call) => call.path === '/api/admin/users')).toBe(false);
  });
  it.each(['admin', 'owner'] as const)(
    'allows %s to create and disable accounts, with role controls only for owner',
    async (value) => {
      role = value;
      await open('/admin/users');
      expect(wrapper!.text()).toContain('writer');
      expect(
        wrapper!.findAll('button').some((item) => item.text() === 'Make admin'),
      ).toBe(value === 'owner');
      await wrapper!.get('#new-username').setValue('newwriter');
      await wrapper!.get('#initial-password').setValue('initial-password');
      await submit();
      expect(wrapper!.text()).toContain('newwriter');
      await button('Disable').trigger('click');
      await flushPromises();
      expect(wrapper!.text()).toContain('Disabled');
      expect(
        calls
          .filter(
            (call) =>
              call.init.method !== 'GET' && call.path.startsWith('/api/admin/'),
          )
          .every(
            (call) =>
              (call.init.headers as Record<string, string>)['X-CSRF-Token'] ===
              'csrf',
          ),
      ).toBe(true);
    },
  );
  it('lets the owner promote and demote a regular account', async () => {
    role = 'owner';
    await open('/admin/users');
    await button('Make admin').trigger('click');
    await flushPromises();
    expect(wrapper!.text()).toContain('Make user');
    await button('Make user').trigger('click');
    await flushPromises();
    expect(
      calls
        .filter((call) => call.path.endsWith('/role'))
        .map((call) => JSON.parse(String(call.init.body)).role),
    ).toEqual(['admin', 'user']);
  });
});
