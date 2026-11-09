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
  <section
    class="mb-7 grid min-w-0 grid-cols-1 gap-4 border-b border-outline py-7 workspace:grid-cols-[minmax(180px,1fr)_minmax(260px,480px)] workspace:gap-9"
  >
    <div>
      <h2>Create account</h2>
      <p>New accounts start with the user role.</p>
    </div>
    <form
      class="rounded-box bg-base-200 p-5 workspace:p-7 flex w-full min-w-0 max-w-[480px] flex-col items-stretch [&>button]:mt-1 [&>button]:self-start"
      @submit.prevent="create"
    >
      <label for="new-username">Username</label>
      <input
        class="input mb-5 min-h-[46px] w-full min-w-0"
        id="new-username"
        v-model="username"
        autocomplete="off"
        required
        minlength="3"
        maxlength="64"
        pattern="[A-Za-z0-9_][A-Za-z0-9_\-]{2,63}"
        aria-describedby="username-help"
      />
      <p id="username-help" class="-mt-3 text-[13px]">
        3–64 letters, numbers, underscores or hyphens; start with a letter,
        number or underscore.
      </p>
      <label for="initial-password">Initial password</label>
      <input
        class="input mb-5 min-h-[46px] w-full min-w-0"
        id="initial-password"
        v-model="password"
        type="password"
        autocomplete="new-password"
        required
        minlength="12"
        maxlength="1024"
        aria-describedby="initial-password-help"
      />
      <p id="initial-password-help" class="-mt-3 text-[13px]">
        Use 12–1024 characters.
      </p>
      <button class="btn btn-primary" :disabled="busy">
        {{ busy ? 'Saving…' : 'Create account' }}
      </button>
    </form>
  </section>
  <section aria-labelledby="accounts-title">
    <h2 id="accounts-title">Accounts</h2>
    <p v-if="loading" role="status">Loading accounts…</p>
    <template v-else>
      <button class="btn" v-if="error" :disabled="busy" @click="load">
        Reload accounts
      </button>
      <div class="overflow-x-auto">
        <table
          class="accounts-table table mt-6 w-full table-fixed [&_th]:whitespace-normal [&_th]:wrap-anywhere [&_td]:whitespace-normal [&_td]:wrap-anywhere workspace:[&_th:first-child]:w-[40%] workspace:[&_th:nth-child(2)]:w-[14%] workspace:[&_th:nth-child(3)]:w-[14%]"
          v-if="users.length"
        >
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
                <div class="actions flex flex-wrap items-start gap-2">
                  <template v-if="user.role !== 'owner'">
                    <button
                      class="btn"
                      :disabled="busy"
                      :aria-label="`${user.disabled ? 'Enable' : 'Disable'} ${user.username}`"
                      @click="update(user, 'disabled')"
                    >
                      {{ user.disabled ? 'Enable' : 'Disable' }}
                    </button>
                    <button
                      class="btn"
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
