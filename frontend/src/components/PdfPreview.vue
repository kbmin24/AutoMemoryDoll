<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api/client';
const props = defineProps<{ jobId: string; compact?: boolean }>();
const emit = defineEmits<{
  error: [message: string];
  unavailable: [message: string];
}>();
const url = ref('');
const error = ref('');
const loading = ref(false);
const isPdfSupported = ref(false);
let disposed = false;
async function load() {
  isPdfSupported.value = Boolean(navigator.pdfViewerEnabled);
  if (!isPdfSupported.value)
    emit(
      'unavailable',
      'Your browser does not support PDF preview. Download the PDF to view it.',
    );
  if (loading.value || disposed) return;
  loading.value = true;
  error.value = '';
  try {
    const pdf = await api<Blob>(
      `/api/jobs/${encodeURIComponent(props.jobId)}/pdf`,
      'GET',
      undefined,
      'blob',
    );
    if (!disposed) url.value = URL.createObjectURL(pdf);
  } catch (cause) {
    if (!disposed) {
      error.value = (cause as Error).message;
      emit('error', error.value);
    }
  } finally {
    loading.value = false;
  }
}
onMounted(load);
onUnmounted(() => {
  disposed = true;
  if (url.value) URL.revokeObjectURL(url.value);
});
</script>
<template>
  <p v-if="loading && !compact" role="status">Loading PDF preview…</p>
  <p v-if="error && !compact" role="alert">
    {{ error }} <button class="btn" @click="load">Retry preview</button>
  </p>
  <template v-if="url">
    <iframe
      v-if="isPdfSupported"
      :src="url"
      title="PDF preview"
      :class="
        compact
          ? 'min-h-0 w-full flex-1 border-0'
          : 'mt-4 min-h-96 w-full flex-1 border-0'
      "
    />
    <p v-else-if="!compact" class="mt-3 text-sm">
      Your browser does not support PDF preview. Please download the PDF file.
    </p>
  </template>
</template>
