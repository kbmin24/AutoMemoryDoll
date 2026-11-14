<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import type { GenerationJob } from '../api/types';

const props = withDefaults(
  defineProps<{
    job: GenerationJob | null;
    submitting?: boolean;
    error?: string;
    notice?: string;
    retryLabel?: string;
    retrying?: boolean;
  }>(),
  { submitting: false, error: '', notice: '', retrying: false },
);
const emit = defineEmits<{ retry: [] }>();
const informationOpen = ref(false);
const informationId = useId();

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
    return `Generation succeeded for document submitted at ${submittedAt}.${props.notice ? ` ${props.notice}` : ''}`;
  }
  return `${job.message} — submitted at ${submittedAt}.`;
});
const canDownload = computed(
  () => props.job?.status === 'ok' && !props.submitting,
);
</script>

<template>
  <header
    class="preview-toolbar relative flex min-h-13 min-w-0 shrink-0 items-center gap-3 rounded-t-box px-4"
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
    <span v-if="information" class="inline-flex">
      <button
        type="button"
        class="btn btn-ghost btn-square text-muted"
        aria-label="Generation information"
        :aria-describedby="informationId"
        :aria-expanded="informationOpen"
        @mouseenter="informationOpen = true"
        @focus="informationOpen = true"
        @blur="informationOpen = false"
        @click="informationOpen = true"
        @keydown.esc.stop.prevent="informationOpen = false"
      >
        <i class="fa-solid fa-info" aria-hidden="true"></i>
      </button>
      <span
        v-show="informationOpen"
        :id="informationId"
        role="tooltip"
        class="absolute top-full right-3 left-3 z-20 rounded-box border border-outline bg-base-100 p-3 text-sm leading-relaxed font-normal text-base-content max-w-96 shadow-lg"
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
    <a
      v-if="canDownload && job"
      class="btn btn-ghost btn-square ml-auto shrink-0"
      :href="`/api/jobs/${encodeURIComponent(job.id)}/pdf`"
      aria-label="Download PDF"
      ><i class="fa-solid fa-download" aria-hidden="true"></i
    ></a>
    <button
      v-else
      type="button"
      class="btn btn-ghost btn-square ml-auto shrink-0"
      aria-label="Download PDF"
      disabled
    >
      <i class="fa-solid fa-download" aria-hidden="true"></i>
    </button>
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
