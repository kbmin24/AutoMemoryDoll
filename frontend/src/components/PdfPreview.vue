<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import VuePdfEmbed from 'vue-pdf-embed';
import 'vue-pdf-embed/dist/styles/textLayer.css';
import { api } from '../api/client';
const props = defineProps<{ jobId: string; zoom: number; compact?: boolean }>();
const page = defineModel<number>('page', { required: true });
const emit = defineEmits<{
  pageCount: [count: number];
  error: [message: string];
}>();
const url = ref('');
const error = ref('');
const loading = ref(false);
const container = ref<HTMLElement>();
const width = ref<number>();
const pageWidth = computed(() =>
  width.value ? Math.round((width.value * props.zoom) / 100) : undefined,
);
let viewport: HTMLElement | null | undefined;
let pageCount = 0;
let activePage = 1;
let lastScrollTop = 0;
let observer: ResizeObserver | undefined;
let disposed = false;
watch(page, (requested) => {
  if (!viewport || requested === activePage) return;
  const marker = container.value?.querySelector(
    `[data-pdf-page="${requested}"]`,
  );
  if (!marker) return;
  activePage = requested;
  viewport.scrollTop +=
    marker.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
  lastScrollTop = viewport.scrollTop;
});

function syncPageFromScroll() {
  if (!viewport || !container.value || viewport.scrollTop === lastScrollTop)
    return;
  lastScrollTop = viewport.scrollTop;
  if (!pageCount) return;

  const top = viewport.getBoundingClientRect().top;
  const atBottom =
    lastScrollTop > 0 &&
    lastScrollTop >= viewport.scrollHeight - viewport.clientHeight - 1;
  let visiblePage = 1;
  if (atBottom) {
    visiblePage = pageCount;
  } else {
    const markers = container.value.querySelectorAll('[data-pdf-page]');
    for (let index = 0; index < markers.length; index += 1) {
      if (markers[index].getBoundingClientRect().top > top + 1) break;
      visiblePage = index + 1;
    }
  }
  activePage = visiblePage;
  page.value = visiblePage;
}

async function load() {
  if (loading.value || disposed) return;
  loading.value = true;
  error.value = '';
  if (url.value) {
    URL.revokeObjectURL(url.value);
    url.value = '';
  }
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
function renderFailure() {
  error.value = 'Could not render the PDF preview.';
  emit('error', error.value);
}
onMounted(() => {
  viewport = container.value?.parentElement;
  viewport?.addEventListener('scroll', syncPageFromScroll, { passive: true });
  if (container.value && typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(([entry]) => {
      const availableWidth = Math.floor(entry.contentRect.width);
      if (availableWidth > 0) width.value = availableWidth;
    });
    observer.observe(container.value);
  }
  void load();
});
onUnmounted(() => {
  disposed = true;
  viewport?.removeEventListener('scroll', syncPageFromScroll);
  observer?.disconnect();
  if (url.value) URL.revokeObjectURL(url.value);
});
</script>
<template>
  <p v-if="loading && !compact" role="status">Loading PDF preview…</p>
  <p v-if="error && !compact" role="alert">
    {{ error }} <button class="btn" @click="load">Retry preview</button>
  </p>
  <div ref="container" :class="compact ? 'w-full' : 'mt-4 w-full'">
    <VuePdfEmbed
      v-if="url && !error"
      :source="url"
      :width="pageWidth"
      class="mx-auto"
      :style="{ width: pageWidth ? `${pageWidth}px` : undefined }"
      text-layer
      role="group"
      aria-label="PDF preview"
      @loaded="pageCount = $event.numPages"
      @rendered="emit('pageCount', pageCount)"
      @loading-failed="renderFailure"
      @rendering-failed="renderFailure"
      @password-requested="renderFailure"
    >
      <template #before-page="{ page: number }">
        <div :data-pdf-page="number" aria-hidden="true"></div>
      </template>
    </VuePdfEmbed>
  </div>
</template>
