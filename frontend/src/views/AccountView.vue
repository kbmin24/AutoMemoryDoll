<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, clearSession, session } from '../api/client';
const router = useRouter();
const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const error = ref('');
const busy = ref(false);
async function submit() {
  error.value = '';
  if (newPassword.value !== confirmPassword.value) {
    error.value = 'New passwords do not match.';
    return;
  }

  busy.value = true;
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
    confirmPassword.value = '';
    busy.value = false;
  }
}
</script>
<template>
  <h1>Account</h1>
  <p>{{ session.user?.username }} · {{ session.user?.role }}</p>
  <section
    class="mb-7 grid min-w-0 grid-cols-1 gap-4 border-b border-outline py-7 workspace:grid-cols-[minmax(180px,1fr)_minmax(260px,480px)] workspace:gap-9"
  >
    <div>
      <h2>Change password</h2>
      <p>You will need to log in again.</p>
    </div>
    <form
      class="rounded-box bg-base-200 p-5 workspace:p-7 flex w-full min-w-0 max-w-[480px] flex-col items-stretch [&>button]:mt-1 [&>button]:self-start"
      @submit.prevent="submit"
    >
      <p v-if="error" role="alert">{{ error }}</p>
      <label for="current-password">Current password</label>
      <input
        class="input mb-5 min-h-[46px] w-full min-w-0"
        id="current-password"
        v-model="currentPassword"
        type="password"
        autocomplete="current-password"
        required
        maxlength="1024"
      />
      <label for="new-password">New password</label>
      <input
        class="input mb-5 min-h-[46px] w-full min-w-0"
        id="new-password"
        v-model="newPassword"
        type="password"
        autocomplete="new-password"
        required
        minlength="12"
        maxlength="1024"
        aria-describedby="password-help"
      />
      <p id="password-help" class="-mt-3 text-[13px]">
        Use 12–1024 characters.
      </p>
      <label for="confirm-password">Confirm new password</label>
      <input
        class="input mb-5 min-h-[46px] w-full min-w-0"
        id="confirm-password"
        v-model="confirmPassword"
        type="password"
        autocomplete="new-password"
        required
        minlength="12"
        maxlength="1024"
      />
      <button class="btn btn-primary" :disabled="busy">
        {{ busy ? 'Saving…' : 'Change password' }}
      </button>
    </form>
  </section>
</template>
