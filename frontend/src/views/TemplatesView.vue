<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api/client';
import type { Template } from '../api/types';

type SharedTemplate = Pick<Template, 'id' | 'name'>;

const tabs = [
  { id: 'owned', label: 'My templates', empty: 'No templates yet.' },
  {
    id: 'shared',
    label: 'Shared with me',
    empty: 'No templates have been shared with you.',
  },
] as const;
const activeTab = ref<(typeof tabs)[number]['id']>('owned');
const templates = ref<{ owned: Template[]; shared: SharedTemplate[] }>({
  owned: [],
  shared: [],
});

function moveTab(event: KeyboardEvent, index: number) {
  const target = {
    ArrowLeft: (index + tabs.length - 1) % tabs.length,
    ArrowRight: (index + 1) % tabs.length,
    Home: 0,
    End: tabs.length - 1,
  }[event.key];
  if (target === undefined) return;

  event.preventDefault();
  activeTab.value = tabs[target].id;
  const button = event.currentTarget as HTMLButtonElement;
  button.parentElement
    ?.querySelector<HTMLButtonElement>(`#${activeTab.value}-templates-tab`)
    ?.focus();
}
const loading = ref(true);
const unavailablePreviews = ref(new Set<string>());
const error = ref('');
async function load() {
  loading.value = true;
  error.value = '';
  unavailablePreviews.value = new Set();
  try {
    const result = await api<{
      templates: Template[];
      sharedTemplates?: SharedTemplate[];
    }>('/api/templates');
    templates.value = {
      owned: result.templates,
      shared: result.sharedTemplates ?? [],
    };
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);
</script>
<template>
  <div class="flex flex-wrap items-center justify-between gap-3">
    <h1 class="m-0">Templates</h1>
    <RouterLink class="btn btn-outline" to="/templates/new"
      ><i class="fa-solid fa-plus"></i> New</RouterLink
    >
  </div>
  <p v-if="error" role="alert">
    {{ error }}
    <button class="btn" @click="load">Retry</button>
  </p>
  <p v-if="loading" role="status">Loading templates…</p>
  <template v-else-if="!error">
    <div
      role="tablist"
      aria-label="Template lists"
      class="mt-4 flex flex-wrap gap-2 border-b border-outline pb-3"
    >
      <button
        v-for="(tab, index) in tabs"
        :id="`${tab.id}-templates-tab`"
        :key="tab.id"
        type="button"
        role="tab"
        class="btn"
        :class="activeTab === tab.id ? 'btn-primary' : 'btn-ghost'"
        :aria-selected="activeTab === tab.id"
        :aria-controls="`${tab.id}-templates-panel`"
        :tabindex="activeTab === tab.id ? 0 : -1"
        @click="activeTab = tab.id"
        @keydown="moveTab($event, index)"
      >
        {{ tab.label }}
      </button>
    </div>
    <section
      v-for="tab in tabs"
      v-show="activeTab === tab.id"
      :id="`${tab.id}-templates-panel`"
      :key="tab.id"
      role="tabpanel"
      :aria-labelledby="`${tab.id}-templates-tab`"
      tabindex="0"
    >
      <template v-if="activeTab === tab.id">
        <ul
          v-if="templates[tab.id].length"
          class="mt-7 grid list-none grid-cols-1 gap-6 p-0 workspace:grid-cols-2 cards:grid-cols-3"
          :aria-label="tab.label"
        >
          <li
            v-for="item in templates[tab.id]"
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
              <span v-else class="text-[13px] text-muted"
                >Preview unavailable</span
              >
            </RouterLink>
            <div
              class="card-body gap-0 px-5 py-[18px] [&_h2]:m-0 [&_h2]:text-base"
            >
              <h2>
                <RouterLink
                  class="link"
                  :to="`/templates/${item.id}/generate`"
                  >{{ item.name }}</RouterLink
                >
              </h2>
              <template v-if="'manifest' in item">
                <RouterLink class="link" :to="`/templates/${item.id}/edit`"
                  >Edit template</RouterLink
                >
                <p class="mt-1 text-[13px]">
                  {{ item.manifest.shape ? 'Form' : 'JSON' }} input
                </p>
              </template>
            </div>
          </li>
        </ul>
        <p
          v-else
          class="mt-6 rounded-box border border-outline bg-base-200 p-6"
        >
          {{ tab.empty }}
        </p>
      </template>
    </section>
  </template>
</template>
