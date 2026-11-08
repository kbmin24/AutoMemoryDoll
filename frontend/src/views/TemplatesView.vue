<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api/client';
import type { Template } from '../api/types';
const templates = ref<Template[]>([]);
const loading = ref(true);
const error = ref('');
const pending = ref<Template | null>(null);
const busy = ref(false);
async function load() {
  loading.value = true;
  error.value = '';
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
  <p>Your private document templates.</p>
  <p v-if="error" role="alert">
    {{ error }} <button :disabled="busy" @click="load">Retry</button>
  </p>
  <p v-if="loading" role="status">Loading templates…</p>
  <template v-else>
    <section v-if="pending" class="confirmation" aria-label="Confirm deletion">
      <h2>Delete {{ pending.name }}?</h2>
      <p>
        This removes its workspace files. Existing jobs and PDFs remain
        available.
      </p>
      <button :disabled="busy" @click="remove">Delete template</button>
      <button :disabled="busy" @click="pending = null">Cancel</button>
    </section>
    <ul
      v-if="templates.length"
      class="template-grid"
      aria-label="Owned templates"
    >
      <li v-for="item in templates" :key="item.id" class="template-card">
        <div class="template-preview">
          <div class="preview-unavailable">Preview unavailable</div>
        </div>
        <div class="template-details">
          <h2>{{ item.name }}</h2>
          <div class="template-footer">
            <p>{{ item.manifest.shape ? 'Form' : 'JSON' }} input</p>
            <button
              class="text-button"
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
    <p v-else-if="!error" class="empty">No templates yet.</p>
  </template>
</template>
