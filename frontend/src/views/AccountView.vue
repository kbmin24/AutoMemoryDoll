<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, clearSession, session } from '../api/client';
const joinedDate = computed(() => {
  const joinedAt = session.user?.joinedAt;
  if (!joinedAt) return null;

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(joinedAt));
});
const router = useRouter();
const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const error = ref('');
const busy = ref(false);
const displayNameDialog = ref<HTMLDialogElement>();
const displayName = computed(
  () => session.user?.displayId ?? session.user?.username ?? '',
);
const displayId = ref('');
const validDisplayName = computed(() =>
  /^(?=[^\0]*\S)[^\0]{3,64}$/u.test(displayId.value),
);
const displayIdBusy = ref(false);
const displayIdError = ref('');
const percentUsed = ref<number | null>();
const usageError = ref(false);

onMounted(async () => {
  try {
    const usage = await api<{ percentUsed: number | null }>(
      '/api/auth/ai-usage',
    );
    percentUsed.value = usage.percentUsed;
  } catch {
    usageError.value = true;
  }
});

function openDisplayNameDialog() {
  displayId.value = displayName.value;
  displayIdError.value = '';
  displayNameDialog.value?.showModal();
}

async function saveDisplayId() {
  const user = session.user;
  if (
    !user ||
    displayIdBusy.value ||
    !validDisplayName.value ||
    displayId.value === displayName.value
  )
    return;

  displayIdBusy.value = true;
  displayIdError.value = '';
  try {
    const result = await api<{ displayId: string }>(
      '/api/auth/display-id',
      'PATCH',
      {
        displayId: displayId.value,
      },
    );
    if (session.user?.id === user.id) session.user.displayId = result.displayId;
    displayNameDialog.value?.close();
  } catch (cause) {
    displayIdError.value = (cause as Error).message;
  } finally {
    displayIdBusy.value = false;
  }
}

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
  <section
    class="mb-7 grid min-w-0 grid-cols-1 gap-4 border-b border-outline py-7 workspace:grid-cols-[minmax(180px,1fr)_minmax(260px,480px)] workspace:gap-9"
    aria-labelledby="account-info-heading"
  >
    <h2 id="account-info-heading">Account Info</h2>
    <dl class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2">
      <dt class="font-semibold">Username</dt>
      <dd class="break-words">{{ session.user?.username }}</dd>
      <dt class="font-semibold">Role</dt>
      <dd>{{ session.user?.role }}</dd>
      <dt class="font-semibold">Joined date</dt>
      <dd>
        <time v-if="joinedDate" :datetime="session.user?.joinedAt ?? undefined">
          {{ joinedDate }}
        </time>
        <template v-else>Unknown</template>
      </dd>
      <dt class="font-semibold">Display Name</dt>
      <dd class="flex min-w-0 flex-wrap items-center gap-2">
        <span class="whitespace-pre-wrap break-words">{{ displayName }}</span>
        <button
          type="button"
          class="link"
          aria-haspopup="dialog"
          @click="openDisplayNameDialog"
        >
          Change
        </button>
      </dd>
    </dl>
  </section>
  <section
    class="mb-7 grid min-w-0 grid-cols-1 gap-4 border-b border-outline py-7 workspace:grid-cols-[minmax(180px,1fr)_minmax(260px,480px)] workspace:gap-9"
    aria-labelledby="ai-usage-heading"
  >
    <div>
      <h2 id="ai-usage-heading">My AI Usage</h2>
      <p>Resets on the first of each month (UTC).</p>
    </div>
    <div class="min-w-0 self-center">
      <p v-if="usageError" role="status">Could not load AI usage.</p>
      <p v-else-if="percentUsed === undefined" role="status">
        Loading AI usage…
      </p>
      <p v-else-if="percentUsed === null">Your monthly AI quota is disabled.</p>
      <template v-else>
        <p class="mb-2 text-sm font-semibold">
          {{ percentUsed }}% of monthly quota used
        </p>
        <progress
          class="progress progress-primary block w-full"
          :value="percentUsed"
          max="100"
          aria-label="Monthly AI usage"
        ></progress>
      </template>
    </div>
  </section>
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
  <dialog
    id="display-name-dialog"
    ref="displayNameDialog"
    class="modal"
    aria-labelledby="display-name-title"
    @cancel="displayIdBusy && $event.preventDefault()"
  >
    <div class="modal-box">
      <h2 id="display-name-title" class="mb-4 text-lg font-bold">
        Change Display Name
      </h2>
      <form @submit.prevent="saveDisplayId">
        <label for="display-name">Display Name</label>
        <input
          id="display-name"
          v-model="displayId"
          class="input w-full"
          type="text"
          required
          autofocus
          aria-describedby="display-name-help"
          :disabled="displayIdBusy"
          @input="displayIdError = ''"
        />
        <p id="display-name-help" class="mt-2 text-sm">
          Use 3–64 characters, including at least one non-whitespace character.
        </p>
        <p v-if="displayIdError" role="alert">{{ displayIdError }}</p>
        <div class="modal-action">
          <button
            type="button"
            class="btn"
            :disabled="displayIdBusy"
            @click="displayNameDialog?.close()"
          >
            Cancel
          </button>
          <button
            type="submit"
            class="btn btn-primary"
            :disabled="
              displayIdBusy || !validDisplayName || displayId === displayName
            "
          >
            {{ displayIdBusy ? 'Saving…' : 'Save' }}
          </button>
        </div>
      </form>
    </div>
  </dialog>
</template>
