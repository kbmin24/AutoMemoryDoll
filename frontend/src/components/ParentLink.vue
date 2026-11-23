<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router';

defineProps<{ to: RouteLocationRaw; label: string }>();
</script>

<template>
  <RouterLink
    :to="to"
    class="mb-2 inline-flex items-center gap-2 self-start text-sm"
  >
    <i class="fa-solid fa-arrow-left" aria-hidden="true"></i>
    <span class="link">{{ label }}</span>
  </RouterLink>
</template>
