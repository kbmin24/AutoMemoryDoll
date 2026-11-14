<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api/client';
import type { GenerationJob } from '../api/types';
const jobs = ref<GenerationJob[]>([]);
const loading = ref(true);
const error = ref('');
async function load() {
  loading.value = true;
  error.value = '';
  try {
    jobs.value = (await api<{ jobs: GenerationJob[] }>('/api/jobs')).jobs;
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);
</script>
<template>
  <h1>Job history</h1>
  <p>Your generated documents and previous attempts.</p>
  <p v-if="loading" role="status">Loading jobs…</p>
  <p v-if="error" role="alert">
    {{ error }}
    <button class="btn" :disabled="loading" @click="load">Retry</button>
  </p>
  <p v-if="!loading && !error && !jobs.length">
    No jobs yet.
    <RouterLink class="link" to="/templates">Choose a template</RouterLink>
  </p>
  <ul class="list-none p-0" aria-label="Generation jobs">
    <li
      v-for="job in jobs"
      :key="job.id"
      class="flex flex-wrap items-center justify-between gap-4 border-b border-outline py-5"
    >
      <div class="min-w-0">
        <RouterLink
          class="link font-semibold wrap-anywhere"
          :to="`/jobs/${job.id}`"
          >{{ job.templateName ?? 'Document' }}</RouterLink
        >
        <p class="mt-2 mb-0">
          {{ new Date(job.timestamp).toLocaleString() }} · {{ job.status }}
        </p>
      </div>
      <a
        v-if="job.status === 'ok'"
        class="btn btn-outline"
        :href="`/api/jobs/${job.id}/pdf`"
        >Download PDF</a
      >
    </li>
  </ul>
</template>
