<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api/client';
import type { GenerationJob, Template } from '../api/types';
import DynamicForm from '../components/DynamicForm.vue';
import JsonEditor from '../components/JsonEditor.vue';
import ResourceUploads from '../components/ResourceUploads.vue';
import GenerationPreview from '../components/GenerationPreview.vue';
const route = useRoute();
const job = ref<GenerationJob | null>(null);
const tab = ref<'form' | 'preview'>('form');
let disposed = false;
onUnmounted(() => {
  disposed = true;
});
function updateJob(value: GenerationJob) {
  job.value = value;
  if (value.status === 'ok') tab.value = 'preview';
}
const template = ref<Template | null>(null);
const aliases = ref<string[]>([]);
const values = ref<Record<string, string>>(Object.create(null));
const files = ref<Record<string, File>>(Object.create(null));
const json = ref('{}');
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const base = `/api/templates/${encodeURIComponent(String(route.params.id))}`;
async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [metadata, resources] = await Promise.all([
      api<{ template: Template }>(base),
      api<{ aliases: string[] }>(`${base}/resources`),
    ]);
    template.value = metadata.template;
    aliases.value = resources.aliases;
    for (const field of metadata.template.manifest.shape?.fields ?? [])
      values.value[field.variable] = '';
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);
function documentData(): Record<string, unknown> {
  if (!template.value!.manifest.shape) {
    try {
      const parsed: unknown = JSON.parse(json.value);
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)
      )
        throw new Error();
      return parsed as Record<string, unknown>;
    } catch {
      throw new Error('Enter a valid JSON object.');
    }
  }
  const data: Record<string, unknown> = Object.create(null);
  for (const field of template.value!.manifest.shape.fields) {
    const value = values.value[field.variable] ?? '';
    if (
      value === '' ||
      ((field.type === 'text' || field.type === 'longtext') &&
        !field.optional &&
        !value.trim())
    ) {
      if (field.optional) continue;
      throw new Error(`${field.label} is required.`);
    }
    if (field.type === 'number') {
      const number = Number(value);
      if (!value.trim() || !Number.isFinite(number))
        throw new Error(`${field.label} must be a finite number.`);
      data[field.variable] = number;
    } else if (field.type === 'boolean') {
      if (value !== 'true' && value !== 'false')
        throw new Error(`${field.label} is required.`);
      data[field.variable] = value === 'true';
    } else data[field.variable] = value;
  }
  return data;
}
async function generate() {
  if (busy.value || !template.value) return;
  error.value = '';
  try {
    const body = new FormData();
    body.append('data', JSON.stringify(documentData()));
    let total = 0;
    for (const alias of aliases.value) {
      const file = files.value[alias];
      if (!file) throw new Error(`Choose a file for ${alias}.`);
      if (file.size > 20 * 1024 * 1024)
        throw new Error(`${alias} exceeds 20 MiB.`);
      total += file.size;
      body.append(alias, file);
    }
    if (total > 100 * 1024 * 1024)
      throw new Error('Files exceed 100 MiB in total.');
    busy.value = true;
    const result = await api<{ job: GenerationJob }>(
      `${base}/generations`,
      'POST',
      body,
    );
    if (!disposed) {
      job.value = result.job;
      tab.value = 'form';
    }
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h1 class="mb-0">{{ template?.name ?? 'Generate document' }}</h1>
      <RouterLink class="link" to="/templates">Templates</RouterLink>
    </div>
    <p v-if="loading" role="status">Loading template…</p>
    <p v-if="error && !template" role="alert">
      {{ error }}
      <button v-if="!template" class="btn" @click="load">Retry</button>
    </p>
    <div class="mb-4 flex gap-2 workspace:hidden" aria-label="Generation panes">
      <button
        class="btn btn-ghost"
        :aria-pressed="tab === 'form'"
        aria-controls="generation-form"
        @click="tab = 'form'"
      >
        Form
      </button>
      <button
        class="btn btn-ghost"
        :aria-pressed="tab === 'preview'"
        aria-controls="generation-preview"
        @click="tab = 'preview'"
      >
        Preview
      </button>
    </div>
    <div
      class="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] gap-4 workspace:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] workspace:gap-x-6"
    >
      <GenerationPreview
        :key="job?.id ?? 'ready'"
        :job="job"
        :submitting="busy"
        :error="error"
        :show-preview="tab === 'preview'"
        @update="updateJob"
      />
      <section
        id="generation-form"
        aria-label="Document values"
        :class="tab === 'form' ? 'flex' : 'hidden'"
        class="row-start-1 min-h-0 min-w-0 flex-col overflow-hidden workspace:col-start-1 workspace:flex"
      >
        <form
          v-if="template && !loading"
          class="flex min-h-0 flex-1 flex-col"
          novalidate
          @submit.prevent="generate"
        >
          <div class="min-h-0 flex-1 overflow-auto pr-1">
            <p v-if="error" class="workspace:hidden" role="alert">
              {{ error }}
            </p>
            <h2 class="mb-5">Document values</h2>
            <DynamicForm
              v-if="template.manifest.shape"
              v-model="values"
              :fields="template.manifest.shape.fields"
              :disabled="busy"
            />
            <JsonEditor v-else v-model="json" :disabled="busy" />
            <ResourceUploads
              v-model="files"
              :aliases="aliases"
              :disabled="busy"
            />
          </div>
          <div class="mt-4 shrink-0 border-t border-outline pt-4">
            <button
              class="btn btn-primary w-full workspace:w-auto"
              :disabled="busy"
            >
              {{ busy ? 'Submitting…' : 'Generate PDF' }}
            </button>
          </div>
        </form>
      </section>
    </div>
  </div>
</template>
