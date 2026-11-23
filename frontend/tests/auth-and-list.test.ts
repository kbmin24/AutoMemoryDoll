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
let joinedAt: string | null;
let displayId: string;
const user = () => ({
  id: 'self',
  username: 'reader',
  role,
  disabled: false,
  displayId,
  joinedAt,
});
const member = {
  id: 'member',
  username: 'writer',
  role: 'user',
  disabled: false,
};

beforeEach(() => {
  role = 'user';
  joinedAt = null;
  displayId = 'reader';
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
      } else if (path === '/api/admin/ai/usage') {
        data = {
          usedTokens: '1234567',
          enabled: true,
          quotaTokens: 5_000_000,
          userQuotaTokens: 100_000,
          resetsAt: new Date(Date.now() + 50 * 60 * 60 * 1000).toISOString(),
        };
      } else if (path === '/api/admin/ai/enabled' && init.method === 'PATCH') {
        data = JSON.parse(String(init.body));
      } else if (path === '/api/admin/ai/quotas' && init.method === 'PATCH') {
        data = {
          appMonthlyTokens: 5_000_000,
          userMonthlyTokens: 100_000,
          ...JSON.parse(String(init.body)),
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
      } else if (path === '/api/auth/display-id') {
        data = { displayId: JSON.parse(String(init.body)).displayId };
      } else if (path === '/api/auth/ai-usage') {
        data = { percentUsed: 42 };
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
  const passwordForm = wrapper!.find('form:has(#current-password)');
  await (passwordForm.exists() ? passwordForm : wrapper!.get('form')).trigger(
    'submit',
  );
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
    await wrapper!.get('.template-card img').trigger('error');
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
    displayId = 'Reader Name';
    const router = await open();
    expect(wrapper!.find('nav a[href="/account"]').exists()).toBe(false);
    expect(wrapper!.find('a[href="/account"]').exists()).toBe(false);
    expect(button('Log out')).toBeUndefined();
    await accountButton().trigger('click');
    expect(accountButton().attributes('aria-expanded')).toBe('true');
    expect(accountButton().attributes('aria-label')).toBe('Account menu');
    expect(accountButton().find('.fa-solid.fa-circle-user').exists()).toBe(
      true,
    );
    expect(accountButton().text()).toBe('');
    expect(wrapper!.get('#account-menu > :first-child').text()).toBe(
      'Reader Name',
    );
    expect(
      wrapper!.find('#account-menu > .account-display-name + hr').exists(),
    ).toBe(true);
    expect(wrapper!.get('a[href="/account"]').text()).toBe('My Account');
    await wrapper!.get('a[href="/account"]').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/account');
    expect(wrapper!.find('#account-menu').exists()).toBe(false);
  });
  it('dismisses account actions with Escape, an outside click, or the menu button', async () => {
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
  it.each([null, '2026-11-22T23:59:59.000Z'])(
    'shows Account Info for an account with join date %s',
    async (date) => {
      joinedAt = date;
      await open('/account');
      const info = wrapper!.get(
        'section[aria-labelledby="account-info-heading"]',
      );
      expect(info.get('h2').text()).toBe('Account Info');
      expect(info.findAll('dt').map((label) => label.text())).toEqual([
        'Username',
        'Role',
        'Joined date',
        'Display Name',
      ]);
      expect(
        info
          .findAll('dd')
          .slice(0, 2)
          .map((value) => value.text()),
      ).toEqual(['reader', 'user']);
      if (date) {
        expect(info.get('time').attributes('datetime')).toBe(date);
        expect(info.get('time').text()).toContain('2026');
      } else {
        expect(info.findAll('dd')[2].text()).toBe('Unknown');
      }
      expect(wrapper!.get('h1').element.nextElementSibling).toBe(info.element);
    },
  );

  it('changes the plain-text display name through a popup', async () => {
    await open('/account');
    const change = button('Change');
    expect(change.element.parentElement?.textContent).toContain('reader');
    const dialog = wrapper!.get<HTMLDialogElement>('#display-name-dialog');
    Object.assign(dialog.element, {
      showModal: () => dialog.element.setAttribute('open', ''),
      close: () => dialog.element.removeAttribute('open'),
    });
    expect(dialog.attributes('open')).toBeUndefined();
    await change.trigger('click');
    expect(dialog.attributes('open')).toBeDefined();
    const input = dialog.get<HTMLInputElement>('#display-name');
    expect(input.element.value).toBe('reader');
    await input.setValue('   ');
    expect(
      dialog.get('button[type="submit"]').attributes('disabled'),
    ).toBeDefined();
    await input.setValue('Shared Name');
    await dialog.get('form').trigger('submit');
    await flushPromises();
    const update = calls.find(({ path }) => path === '/api/auth/display-id')!;
    expect(update.init.method).toBe('PATCH');
    expect(JSON.parse(String(update.init.body))).toEqual({
      displayId: 'Shared Name',
    });
    expect(session.user).toMatchObject({
      username: 'reader',
      displayId: 'Shared Name',
    });
    expect(change.element.parentElement?.textContent).toContain('Shared Name');
    expect(dialog.attributes('open')).toBeUndefined();
  });

  it('shows personal monthly AI usage as a percentage', async () => {
    await open('/account');
    expect(wrapper!.text()).toContain('My AI Usage');
    const progress = wrapper!.get('progress[aria-label="Monthly AI usage"]');
    expect(progress.attributes('value')).toBe('42');
    expect(progress.attributes('max')).toBe('100');
    expect(wrapper!.text()).toContain('42%');
  });

  it('changes the password and requires login again', async () => {
    const router = await open('/account');
    await wrapper!.get('#current-password').setValue('current-password');
    await wrapper!.get('#new-password').setValue('replacement-password');
    await wrapper!.get('#confirm-password').setValue('replacement-password');
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
    await wrapper!.get('#confirm-password').setValue('replacement-password');
    await submit();
    expect(router.currentRoute.value.path).toBe('/account');
    expect(session.user?.username).toBe('reader');
    expect(wrapper!.get('[role="alert"]').text()).toContain(
      'Current password is incorrect',
    );
    expect(
      (wrapper!.get('#confirm-password').element as HTMLInputElement).value,
    ).toBe('');
  });
  it.each(['', 'different-password'])(
    'rejects confirmation %j without sending a password change and allows correction',
    async (confirmation) => {
      const router = await open('/account');
      await wrapper!.get('#current-password').setValue('current-password');
      await wrapper!.get('#new-password').setValue('replacement-password');
      await wrapper!.get('#confirm-password').setValue(confirmation);
      await submit();
      expect(wrapper!.get('[role="alert"]').text()).toContain(
        'New passwords do not match',
      );
      expect(calls.some((call) => call.path === '/api/auth/password')).toBe(
        false,
      );
      expect(router.currentRoute.value.path).toBe('/account');
      expect(session.user?.username).toBe('reader');
      await wrapper!.get('#confirm-password').setValue('replacement-password');
      await submit();
      expect(router.currentRoute.value.path).toBe('/login');
    },
  );
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
    const router = await open('/admin');
    expect(router.currentRoute.value.path).toBe('/templates');
    expect(wrapper!.find('nav a[href="/admin"]').exists()).toBe(false);
    await router.push('/admin/users');
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/templates');
    expect(wrapper!.find('a[href="/admin/users"]').exists()).toBe(false);
    expect(calls.some((call) => call.path === '/api/admin/users')).toBe(false);
  });
  it('opens AI usage from Admin and shows exact counts', async () => {
    role = 'admin';
    const router = await open('/admin');
    await wrapper!.get('main a[href="/admin/ai"]').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/admin/ai');
    expect(wrapper!.get('main h1').text()).toBe('AI');
    expect(wrapper!.text()).toContain('1,234,567');
    expect(wrapper!.text()).toContain('5,000,000');
    expect(wrapper!.get('main progress').attributes('value')).toBe('24.69');
  });

  it('lets an admin disable and re-enable AI for the website', async () => {
    role = 'admin';
    await open('/admin/ai');
    const toggle = wrapper!.get<HTMLInputElement>('input[role="switch"]');
    expect(toggle.element.checked).toBe(true);
    for (const enabled of [false, true]) {
      await toggle.setValue(enabled);
      await flushPromises();
      expect(toggle.element.checked).toBe(enabled);
      const call = calls
        .filter(({ path }) => path === '/api/admin/ai/enabled')
        .at(-1)!;
      expect(call.init.method).toBe('PATCH');
      expect(call.init.headers).toMatchObject({ 'X-CSRF-Token': 'csrf' });
      expect(JSON.parse(String(call.init.body))).toEqual({ enabled });
    }
  });

  it('shows time remaining and saves both AI quota limits', async () => {
    role = 'owner';
    await open('/admin/ai');
    expect(wrapper!.text()).toMatch(/Resets in 2 days, 2 hours/);
    const website = wrapper!.get<HTMLInputElement>('#app-ai-limit');
    const personal = wrapper!.get<HTMLInputElement>('#user-ai-limit');
    expect(website.element.value).toBe('5000000');
    expect(personal.element.value).toBe('100000');
    await website.setValue('6000000');
    await personal.setValue('120000');
    await wrapper!.get('form').trigger('submit');
    await flushPromises();
    const call = calls.find(({ path }) => path === '/api/admin/ai/quotas')!;
    expect(call.init.method).toBe('PATCH');
    expect(call.init.headers).toMatchObject({ 'X-CSRF-Token': 'csrf' });
    expect(JSON.parse(String(call.init.body))).toEqual({
      appMonthlyTokens: 6_000_000,
      userMonthlyTokens: 120_000,
    });
    expect(wrapper!.text()).toContain('6,000,000');
    expect(wrapper!.text()).toContain('Limits saved.');
  });

  it.each(['admin', 'owner'] as const)(
    'opens the Admin landing page and Users tile for %s',
    async (value) => {
      role = value;
      const router = await open();
      const adminLink = wrapper!.get('nav a[href="/admin"]');
      expect(adminLink.text()).toBe('Admin');
      expect(wrapper!.find('nav a[href="/admin/users"]').exists()).toBe(false);
      await adminLink.trigger('click');
      await flushPromises();
      expect(router.currentRoute.value.path).toBe('/admin');
      expect(wrapper!.get('main h1').text()).toBe('Admin');
      const tile = wrapper!.get('main a[href="/admin/users"]');
      expect(tile.text()).toBe('Users');
      await tile.trigger('click');
      await flushPromises();
      expect(router.currentRoute.value.path).toBe('/admin/users');
      expect(wrapper!.get('main h1').text()).toBe('Users');
    },
  );

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
      const name = wrapper!.get<HTMLInputElement>('#new-display-name');
      if (value === 'owner') await name.setValue('Writer Name');
      await wrapper!.get('#initial-password').setValue('initial-password');
      await submit();
      const create = calls.find(
        ({ path, init }) =>
          path === '/api/admin/users' && init.method === 'POST',
      )!;
      expect(JSON.parse(String(create.init.body))).toEqual({
        username: 'newwriter',
        password: 'initial-password',
        ...(value === 'owner' ? { displayId: 'Writer Name' } : {}),
      });
      expect(name.element.value).toBe('');
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
