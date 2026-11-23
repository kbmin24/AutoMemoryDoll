<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api/client';

const props = defineProps<{ template: { id: string; name: string } }>();
const emit = defineEmits<{ close: [] }>();

type Recipient = { id: string; username: string };

const dialog = ref<HTMLDialogElement>();
const recipients = ref<Recipient[]>();
const username = ref('');
const loading = ref(true);
const saving = ref(false);
const error = ref('');
const path = `/api/templates/${encodeURIComponent(props.template.id)}/shares`;

async function load() {
  loading.value = true;
  error.value = '';
  try {
    recipients.value = (
      await api<{ recipients: Recipient[] }>(path)
    ).recipients;
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  dialog.value?.showModal();
  void load();
});

async function invite() {
  if (saving.value || !recipients.value || !username.value) return;
  saving.value = true;
  error.value = '';
  try {
    const recipient = await api<Recipient>(path, 'POST', {
      username: username.value,
    });
    if (!recipients.value.some(({ id }) => id === recipient.id))
      recipients.value.push(recipient);
    username.value = '';
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    saving.value = false;
  }
}

async function revoke(recipient: Recipient) {
  if (saving.value || !recipients.value) return;
  saving.value = true;
  error.value = '';
  try {
    await api(`${path}/${encodeURIComponent(recipient.id)}`, 'DELETE');
    recipients.value = recipients.value.filter(
      ({ id }) => id !== recipient.id,
    );
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <dialog
    ref="dialog"
    class="modal"
    aria-labelledby="template-share-title"
    @cancel="saving && $event.preventDefault()"
    @close="emit('close')"
  >
    <div class="modal-box">
      <h2
        id="template-share-title"
        class="mb-4 text-lg font-bold break-words"
      >
        Share {{ template.name }}
      </h2>
      <p v-if="loading" role="status">Loading recipients…</p>
      <p v-if="error" role="alert">{{ error }}</p>
      <button
        v-if="!loading && !recipients"
        type="button"
        class="btn"
        @click="load"
      >
        Retry
      </button>
      <template v-if="recipients">
        <form class="space-y-2" @submit.prevent="invite">
          <label class="block" for="template-share-username">Username</label>
          <div class="flex flex-wrap gap-2">
            <input
              id="template-share-username"
              v-model="username"
              class="input min-w-0 flex-1"
              type="text"
              required
              minlength="3"
              maxlength="64"
              pattern="[A-Za-z0-9_][A-Za-z0-9_\-]{2,63}"
              :readonly="saving"
            />
            <button type="submit" class="btn btn-primary" :disabled="saving">
              Invite
            </button>
          </div>
        </form>
        <h3 class="mt-5 text-sm font-semibold">Recipients</h3>
        <p v-if="!recipients.length">No recipients yet.</p>
        <ul v-else class="m-0 list-none divide-y divide-outline p-0">
          <li
            v-for="recipient in recipients"
            :key="recipient.id"
            class="flex items-center justify-between gap-3 py-2"
          >
            <span class="min-w-0 break-words">{{ recipient.username }}</span>
            <button
              type="button"
              class="btn btn-ghost"
              :disabled="saving"
              :aria-label="`Revoke access for ${recipient.username}`"
              @click="revoke(recipient)"
            >
              Revoke
            </button>
          </li>
        </ul>
        <p v-if="saving" class="sr-only" role="status">Updating access…</p>
      </template>
      <div class="modal-action">
        <button
          type="button"
          class="btn"
          :disabled="saving"
          @click="dialog?.close()"
        >
          Close
        </button>
      </div>
    </div>
  </dialog>
</template>
