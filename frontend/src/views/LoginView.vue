<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { login } from '../api/client';
const router = useRouter();
const route = useRoute();
const username = ref('');
const password = ref('');
const error = ref('');
const busy = ref(false);
async function submit() {
  busy.value = true;
  error.value = '';
  try {
    await login(username.value, password.value);
    await router.replace('/templates');
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    password.value = '';
    busy.value = false;
  }
}
</script>
<template>
  <section class="mx-auto my-[5vh] w-full max-w-[380px] workspace:my-[7vh]">
    <h1>Log in</h1>
    <p v-if="route.query.passwordChanged === '1'" role="status">
      Password changed. Log in with your new password.
    </p>
    <p v-if="error" role="alert">{{ error }}</p>
    <form
      class="flex w-full min-w-0 max-w-[480px] flex-col items-stretch [&>button]:mt-1 [&>button]:self-stretch workspace:[&>button]:self-start"
      @submit.prevent="submit"
    >
      <label for="username">Username</label>
      <input
        class="input mb-5 min-h-[46px] w-full min-w-0"
        id="username"
        v-model="username"
        autocomplete="username"
        required
        maxlength="64"
      />
      <label for="password">Password</label>
      <input
        class="input mb-5 min-h-[46px] w-full min-w-0"
        id="password"
        v-model="password"
        type="password"
        autocomplete="current-password"
        required
        maxlength="1024"
      />
      <button class="btn btn-primary" :disabled="busy">
        {{ busy ? 'Logging in…' : 'Log in' }}
      </button>
    </form>
  </section>
</template>
