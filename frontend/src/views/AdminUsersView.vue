<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, session } from '../api/client';
import type { User } from '../api/types';
const users = ref<User[]>([]);
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const message = ref('');
const username = ref('');
const password = ref('');
async function load() {
  loading.value = true;
  error.value = '';
  try {
    users.value = (await api<{ users: User[] }>('/api/admin/users')).users;
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);
async function create() {
  busy.value = true;
  error.value = '';
  message.value = '';
  try {
    const result = await api<{ user: User }>('/api/admin/users', 'POST', {
      username: username.value,
      password: password.value,
    });
    users.value.push(result.user);
    username.value = '';
    message.value = 'Account created.';
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    password.value = '';
    busy.value = false;
  }
}
async function update(user: User, action: 'disabled' | 'role') {
  busy.value = true;
  error.value = '';
  message.value = '';
  try {
    const path =
      action === 'role'
        ? `/api/owner/users/${user.id}/role`
        : `/api/admin/users/${user.id}`;
    const body =
      action === 'role'
        ? { role: user.role === 'admin' ? 'user' : 'admin' }
        : { disabled: !user.disabled };
    const result = await api<{ user: User }>(path, 'PATCH', body);
    users.value = users.value.map((item) =>
      item.id === user.id ? result.user : item,
    );
    if (user.id === session.user?.id) session.user = result.user;
    message.value = 'Account updated.';
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <h1>Users</h1>
  <p>Manage accounts. Document work stays private to each user.</p>
  <p v-if="error" role="alert">{{ error }}</p>
  <p v-if="message" role="status">{{ message }}</p>
  <section class="settings">
    <div>
      <h2>Create account</h2>
      <p>New accounts start with the user role.</p>
    </div>
    <form @submit.prevent="create">
      <label for="new-username">Username</label>
      <input
        id="new-username"
        v-model="username"
        autocomplete="off"
        required
        minlength="3"
        maxlength="64"
        pattern="[A-Za-z0-9_][A-Za-z0-9_\-]{2,63}"
        aria-describedby="username-help"
      />
      <p id="username-help" class="hint">
        3–64 letters, numbers, underscores or hyphens; start with a letter,
        number or underscore.
      </p>
      <label for="initial-password">Initial password</label>
      <input
        id="initial-password"
        v-model="password"
        type="password"
        autocomplete="new-password"
        required
        minlength="12"
        maxlength="1024"
        aria-describedby="initial-password-help"
      />
      <p id="initial-password-help" class="hint">Use 12–1024 characters.</p>
      <button class="primary" :disabled="busy">
        {{ busy ? 'Saving…' : 'Create account' }}
      </button>
    </form>
  </section>
  <section aria-labelledby="accounts-title">
    <h2 id="accounts-title">Accounts</h2>
    <p v-if="loading" role="status">Loading accounts…</p>
    <template v-else>
      <button v-if="error" :disabled="busy" @click="load">
        Reload accounts
      </button>
      <div class="table-scroll">
        <table v-if="users.length">
          <caption class="sr-only">
            User accounts
          </caption>
          <thead>
            <tr>
              <th scope="col">Username</th>
              <th scope="col">Role</th>
              <th scope="col">Status</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="user in users" :key="user.id">
              <th scope="row">{{ user.username }}</th>
              <td data-label="Role">{{ user.role }}</td>
              <td data-label="Status">
                {{ user.disabled ? 'Disabled' : 'Active' }}
              </td>
              <td data-label="Actions">
                <div class="actions">
                  <template v-if="user.role !== 'owner'">
                    <button
                      :disabled="busy"
                      :aria-label="`${user.disabled ? 'Enable' : 'Disable'} ${user.username}`"
                      @click="update(user, 'disabled')"
                    >
                      {{ user.disabled ? 'Enable' : 'Disable' }}
                    </button>
                    <button
                      v-if="session.user?.role === 'owner'"
                      :disabled="busy"
                      :aria-label="`Make ${user.username} ${user.role === 'admin' ? 'user' : 'admin'}`"
                      @click="update(user, 'role')"
                    >
                      {{ user.role === 'admin' ? 'Make user' : 'Make admin' }}
                    </button> </template
                  ><span v-else>Owner account</span>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </section>
</template>
