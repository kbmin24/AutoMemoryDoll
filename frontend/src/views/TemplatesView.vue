<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api/client';
import type { Template } from '../api/types';
const templates = ref<Template[]>([]);
const loading = ref(true);
const unavailablePreviews = ref(new Set<string>());
const error = ref('');
const pending = ref<Template | null>(null);
const busy = ref(false);
async function load() {
  loading.value = true;
  error.value = '';
  unavailablePreviews.value = new Set();
  try {
    templates.value = (
      await api<{ templates: Template[] }>('/api/templates')
    ).templates;
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);
async function remove() {
  if (!pending.value) return;
  busy.value = true;
  error.value = '';
  try {
    await api(`/api/templates/${pending.value.id}`, 'DELETE');
    templates.value = templates.value.filter(
      (item) => item.id !== pending.value!.id,
    );
    pending.value = null;
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <h1>Templates</h1>
  <RouterLink class="btn btn-outline" to="/templates/new"
    >New template</RouterLink
  >
  <p>Your private document templates.</p>
  <p v-if="error" role="alert">
    {{ error }}
    <button class="btn" :disabled="busy" @click="load">Retry</button>
  </p>
  <p v-if="loading" role="status">Loading templates…</p>
  <template v-else>
    <section
      v-if="pending"
      class="mt-6 rounded-box border border-outline bg-base-200 p-6 [&_button]:mr-2 [&_button]:mt-1"
      aria-label="Confirm deletion"
    >
      <h2>Delete {{ pending.name }}?</h2>
      <p>
        This removes its workspace files. Existing jobs and PDFs remain
        available.
      </p>
      <button class="btn" :disabled="busy" @click="remove">
        Delete template
      </button>
      <button class="btn" :disabled="busy" @click="pending = null">
        Cancel
      </button>
    </section>
    <ul
      v-if="templates.length"
      class="mt-7 grid list-none grid-cols-1 gap-6 p-0 workspace:grid-cols-2 cards:grid-cols-3"
      aria-label="Owned templates"
    >
      <li
        v-for="item in templates"
        :key="item.id"
        class="template-card card min-w-0 overflow-hidden border border-outline bg-white"
      >
        <RouterLink
          class="grid h-[255px] place-items-center overflow-hidden bg-base-300"
          :to="`/templates/${item.id}/generate`"
          :aria-label="`Generate from ${item.name}`"
        >
          <img
            v-if="!unavailablePreviews.has(item.id)"
            class="h-full min-h-0 w-full object-cover object-top"
            :src="`/api/templates/${item.id}/preview`"
            alt=""
            loading="lazy"
            @error="unavailablePreviews.add(item.id)"
          />
          <span v-else class="text-[13px] text-muted">Preview unavailable</span>
        </RouterLink>
        <div class="card-body gap-0 px-5 py-[18px] [&_h2]:m-0 [&_h2]:text-base">
          <h2>
            <RouterLink class="link" :to="`/templates/${item.id}/generate`">{{
              item.name
            }}</RouterLink>
          </h2>
          <RouterLink class="link" :to="`/templates/${item.id}/edit`"
            >Edit template</RouterLink
          >
          <div
            class="mt-1 flex items-center justify-between gap-3 [&_p]:m-0 [&_p]:text-[13px]"
          >
            <p>{{ item.manifest.shape ? 'Form' : 'JSON' }} input</p>
            <button
              class="btn btn-ghost"
              :disabled="busy"
              :aria-label="`Delete ${item.name}`"
              @click="pending = item"
            >
              Delete
            </button>
          </div>
        </div>
      </li>
    </ul>
    <p
      v-else-if="!error"
      class="mt-6 rounded-box border border-outline bg-base-200 p-6"
    >
      No templates yet.
    </p>
  </template>
</template>
