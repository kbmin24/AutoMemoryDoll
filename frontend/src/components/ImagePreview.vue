<script setup lang="ts">
import { ref } from "vue";

defineProps<{ src: string; name: string }>();

const failed = ref(false);
const loaded = ref(false);
</script>

<template>
  <p v-if="failed" role="status">
    This image could not be previewed. It may be unsupported, damaged, or exceed
    preview limits. Download it from its three-dot menu or select another file.
  </p>
  <div v-else class="min-h-0 flex-1 overflow-auto">
    <p v-if="!loaded" role="status">Loading image…</p>
    <img
      :src="src"
      :alt="`Preview of ${name}`"
      class="block max-h-full max-w-full object-contain"
      @load="loaded = true"
      @error="failed = true"
    />
  </div>
</template>
