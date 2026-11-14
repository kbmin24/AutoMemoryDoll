<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api/client';
import type { GenerationJob } from '../api/types';
import PdfPreview from './PdfPreview.vue';
import JobStatusBar from './JobStatusBar.vue';

const props = defineProps<{
  job: GenerationJob | null;
  submitting: boolean;
  error: string;
  showPreview: boolean;
}>();
const emit = defineEmits<{ update: [job: GenerationJob] }>();
const currentJob = ref(props.job);
const pollError = ref('');
const previewError = ref('');
const previewNotice = ref('');
const previewAttempt = ref(0);
const loading = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;

const failure = computed(
  () => props.error || pollError.value || previewError.value,
);
async function load() {
  if (loading.value || disposed || !currentJob.value) return;
  clearTimeout(timer);
  loading.value = true;
  pollError.value = '';
  try {
    const id = encodeURIComponent(currentJob.value.id);
    const result = await api<{ job: GenerationJob }>(`/api/jobs/${id}`);
    if (disposed) return;
    currentJob.value = result.job;
    emit('update', result.job);
    if (result.job.status === 'queued' || result.job.status === 'generating') {
      timer = setTimeout(load, 2000);
    }
  } catch (cause) {
    if (!disposed) pollError.value = (cause as Error).message;
  } finally {
    loading.value = false;
  }
}
function retry() {
  if (pollError.value) {
    void load();
  } else {
    previewError.value = '';
    previewAttempt.value += 1;
  }
}
onMounted(load);
onUnmounted(() => {
  disposed = true;
  clearTimeout(timer);
});
</script>

<template>
  <section
    id="generation-preview"
    aria-label="Document preview"
    class="row-start-1 min-h-0 min-w-0 flex-col rounded-box border border-outline bg-base-300 workspace:col-start-2 workspace:flex"
    :class="showPreview ? 'flex' : 'hidden'"
  >
    <JobStatusBar
      :job="currentJob"
      :submitting="submitting"
      :error="failure"
      :notice="previewNotice"
      :retry-label="
        pollError ? 'Retry status' : previewError ? 'Retry preview' : undefined
      "
      :retrying="loading"
      @retry="retry"
    />
    <div class="flex min-h-0 flex-1 flex-col overflow-auto rounded-b-box">
      <PdfPreview
        v-if="currentJob?.status === 'ok'"
        :key="previewAttempt"
        :job-id="currentJob.id"
        compact
        @error="previewError = $event"
        @unavailable="previewNotice = $event"
      />
    </div>
  </section>
</template>
