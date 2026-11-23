<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import type { GenerationJob } from '../api/types';

const props = withDefaults(
  defineProps<{
    job: GenerationJob | null;
    pageCount: number;
    submitting?: boolean;
    error?: string;
    retryLabel?: string;
    retrying?: boolean;
  }>(),
  { submitting: false, error: '', retrying: false },
);
const page = defineModel<number>('page', { required: true });
const zoom = defineModel<number>('zoom', { required: true });
const minZoom = 25;
const maxZoom = 200;
const zoomStep = 25;
const emit = defineEmits<{ retry: [] }>();
const informationOpen = ref(false);
const informationButton = ref<HTMLButtonElement | null>(null);
const informationId = useId();

function changePage(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  const value = input.value.trim();
  const requested = Number(value);
  if (/^\d+$/.test(value) && requested >= 1 && requested <= props.pageCount) {
    page.value = requested;
    input.value = String(requested);
    return;
  }
  input.value = String(page.value);
}

function handleInformationFocusOut(event: FocusEvent) {
  const container = event.currentTarget as HTMLElement;
  if (!container.contains(event.relatedTarget as Node | null)) {
    informationOpen.value = false;
  }
}

function dismissInformation() {
  informationButton.value?.focus();
  informationOpen.value = false;
}

const state = computed(() => {
  if (props.submitting) return 'generating';
  if (props.error || props.job?.status === 'failed') return 'error';
  if (!props.job) return 'ready';
  return props.job.status === 'ok' ? 'generated' : 'generating';
});
const statusText = computed(
  () =>
    ({
      ready: 'Ready',
      generating: 'Generating...',
      generated: 'Generated',
      error: 'Error',
    })[state.value],
);
const information = computed(() => {
  if (props.submitting) return '';
  if (props.error) return props.error;
  const job = props.job;
  if (!job) return '';
  if (job.status === 'failed') return job.message;
  const submittedAt = new Date(job.timestamp).toLocaleString();
  if (job.status === 'ok') {
    return `Generation succeeded for document submitted at ${submittedAt}.`;
  }
  return `${job.message} — submitted at ${submittedAt}.`;
});
const canDownload = computed(
  () => props.job?.status === 'ok' && !props.submitting,
);
</script>

<template>
  <header
    class="preview-toolbar relative flex min-h-13 min-w-0 shrink-0 flex-wrap items-center gap-x-1 rounded-t-box px-4 sm:gap-x-3"
    :data-state="state"
    :role="state === 'error' ? 'alert' : 'status'"
    aria-label="Generation status"
    @mouseleave="informationOpen = false"
  >
    <span class="flex shrink-0 items-center gap-2 text-sm font-semibold">
      <span
        v-if="state === 'generating'"
        class="loading loading-spinner loading-sm"
        aria-hidden="true"
      ></span>
      <i
        v-else-if="state === 'generated'"
        class="fa-solid fa-check"
        aria-hidden="true"
      ></i>
      <i
        v-else-if="state === 'error'"
        class="fa-solid fa-x"
        aria-hidden="true"
      ></i>
      {{ statusText }}
    </span>
    <span
      v-if="information"
      class="inline-flex"
      @focusout="handleInformationFocusOut"
      @keydown.esc.stop.prevent="dismissInformation"
    >
      <button
        ref="informationButton"
        type="button"
        class="btn btn-ghost btn-square text-muted"
        aria-label="Generation information"
        :aria-describedby="informationId"
        :aria-expanded="informationOpen"
        @mouseenter="informationOpen = true"
        @focus="informationOpen = true"
        @click="informationOpen = true"
      >
        <i class="fa-solid fa-info" aria-hidden="true"></i>
      </button>
      <span
        v-show="informationOpen"
        :id="informationId"
        role="tooltip"
        tabindex="0"
        class="absolute top-full right-3 left-3 z-20 max-h-80 max-w-96 overflow-auto rounded-box border border-outline bg-base-100 p-3 text-sm leading-relaxed font-normal whitespace-pre-wrap break-words text-base-content shadow-lg"
        >{{ information }}</span
      >
    </span>
    <button
      v-if="retryLabel"
      type="button"
      class="btn btn-ghost px-2 text-sm"
      :aria-label="retryLabel"
      :disabled="retrying"
      @click="emit('retry')"
    >
      Retry
    </button>
    <div class="ml-auto flex shrink-0 items-center">
      <template v-if="state === 'generated'">
        <div
          v-if="pageCount"
          class="mr-2 flex items-center gap-1 text-sm tabular-nums"
        >
          <input
            type="text"
            inputmode="numeric"
            aria-label="Current page"
            class="input input-sm w-12 px-1 text-center"
            :value="page"
            @change="changePage"
            @keydown.enter.prevent="changePage"
          />
          <span>of {{ pageCount }}</span>
        </div>
        <button
          type="button"
          class="btn btn-ghost btn-square"
          aria-label="Zoom out"
          title="Zoom out"
          :disabled="zoom <= minZoom"
          @click="zoom -= zoomStep"
        >
          <i class="fa-solid fa-magnifying-glass-minus" aria-hidden="true"></i>
        </button>
        <output
          aria-label="Zoom level"
          class="w-11 text-center text-sm tabular-nums"
          >{{ zoom }}%</output
        >
        <button
          type="button"
          class="btn btn-ghost btn-square"
          aria-label="Zoom in"
          title="Zoom in"
          :disabled="zoom >= maxZoom"
          @click="zoom += zoomStep"
        >
          <i class="fa-solid fa-magnifying-glass-plus" aria-hidden="true"></i>
        </button>
      </template>
      <a
        v-if="canDownload && job"
        class="btn btn-ghost btn-square"
        :href="`/api/jobs/${encodeURIComponent(job.id)}/pdf`"
        aria-label="Download PDF"
        ><i class="fa-solid fa-download" aria-hidden="true"></i
      ></a>
      <button
        v-else
        type="button"
        class="btn btn-ghost btn-square"
        aria-label="Download PDF"
        disabled
      >
        <i class="fa-solid fa-download" aria-hidden="true"></i>
      </button>
    </div>
  </header>
</template>

<style scoped>
.preview-toolbar {
  background: var(--color-base-300);
  color: var(--color-base-content);
}
.preview-toolbar[data-state='error'] {
  background: #f8e9e8;
  color: #8f2d2d;
}
.preview-toolbar[data-state='generated'] {
  background: #e8f0e8;
  color: #33523b;
}
</style>
