import { reactive } from 'vue';
import type { AuthSession, User } from './types';

export const session = reactive({
  user: null as User | null,
  csrfToken: null as string | null,
});

export function clearSession() {
  session.user = null;
  session.csrfToken = null;
}

export async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  if (method !== 'GET' && session.csrfToken) {
    headers['X-CSRF-Token'] = session.csrfToken;
  }
  const response = await fetch(path, {
    method,
    credentials: 'include',
    headers,
    ...(body === undefined
      ? {}
      : { body: body instanceof FormData ? body : JSON.stringify(body) }),
  });
  if (response.status === 401 && path !== '/api/auth/login') {
    if (path === '/api/auth/password') {
      // This endpoint also uses 401 for an incorrect current password.
      await refreshSession().catch(() => undefined);
    } else {
      clearSession();
    }
  }
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(
      typeof data?.error === 'string'
        ? data.error
        : 'Request failed. Please try again.',
    );
  }
  const content = await response.text();
  return content.length === 0 ? (undefined as T) : JSON.parse(content);
}

export async function refreshSession() {
  Object.assign(session, await api<AuthSession>('/api/auth/me'));
}

export async function login(username: string, password: string) {
  Object.assign(
    session,
    await api<AuthSession>('/api/auth/login', 'POST', { username, password }),
  );
}

export async function logout() {
  await api('/api/auth/logout', 'POST');
  clearSession();
}
