<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, clearSession, session } from '../api/client';
const router = useRouter();
const currentPassword = ref('');
const newPassword = ref('');
const error = ref('');
const busy = ref(false);
async function submit() {
  busy.value = true;
  error.value = '';
  try {
    await api('/api/auth/password', 'POST', {
      currentPassword: currentPassword.value,
      newPassword: newPassword.value,
    });
    clearSession();
    await router.replace('/login?passwordChanged=1');
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    currentPassword.value = '';
    newPassword.value = '';
    busy.value = false;
  }
}
</script>
<template>
  <h1>Account</h1>
  <p>{{ session.user?.username }} · {{ session.user?.role }}</p>
  <section class="settings">
    <div>
      <h2>Change password</h2>
      <p>You will need to log in again.</p>
    </div>
    <form @submit.prevent="submit">
      <p v-if="error" role="alert">{{ error }}</p>
      <label for="current-password">Current password</label>
      <input
        id="current-password"
        v-model="currentPassword"
        type="password"
        autocomplete="current-password"
        required
        maxlength="1024"
      />
      <label for="new-password">New password</label>
      <input
        id="new-password"
        v-model="newPassword"
        type="password"
        autocomplete="new-password"
        required
        minlength="12"
        maxlength="1024"
        aria-describedby="password-help"
      />
      <p id="password-help" class="hint">Use 12–1024 characters.</p>
      <button class="primary" :disabled="busy">
        {{ busy ? 'Saving…' : 'Change password' }}
      </button>
    </form>
  </section>
</template>
