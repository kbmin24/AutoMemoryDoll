<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api/client';
import type { GenerationJob } from '../api/types';
import PdfPreview from './PdfPreview.vue';
import JobStatusBar from './JobStatusBar.vue';
const props = defineProps<{ jobId: string }>();
const emit = defineEmits<{ update: [job: GenerationJob] }>();
const id = encodeURIComponent(props.jobId);
const job = ref<GenerationJob | null>(null);
const error = ref('');
const previewError = ref('');
const previewNotice = ref('');
const previewAttempt = ref(0);
const loading = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
async function load() {
  if (loading.value || disposed) return;
  clearTimeout(timer);
  loading.value = true;
  error.value = '';
  try {
    const result = await api<{ job: GenerationJob }>(`/api/jobs/${id}`);
    if (disposed) return;
    job.value = result.job;
    emit('update', result.job);
    if (job.value.status === 'queued' || job.value.status === 'generating')
      timer = setTimeout(load, 2000);
  } catch (cause) {
    if (!disposed) error.value = (cause as Error).message;
  } finally {
    loading.value = false;
  }
}
function retry() {
  if (error.value) {
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
    aria-label="Document preview"
    class="flex min-h-0 flex-1 flex-col rounded-box border border-outline bg-base-300"
  >
    <JobStatusBar
      :job="job"
      :submitting="loading && !job"
      :error="error || previewError"
      :notice="previewNotice"
      :retry-label="
        error ? 'Retry status' : previewError ? 'Retry preview' : undefined
      "
      :retrying="loading"
      @retry="retry"
    />
    <div class="flex min-h-0 flex-1 flex-col overflow-auto rounded-b-box">
      <PdfPreview
        v-if="job?.status === 'ok'"
        :key="previewAttempt"
        :job-id="jobId"
        compact
        @error="previewError = $event"
        @unavailable="previewNotice = $event"
      />
    </div>
  </section>
</template>
