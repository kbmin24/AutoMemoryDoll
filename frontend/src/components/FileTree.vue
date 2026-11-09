<script setup lang="ts">
import { computed } from 'vue';
import type { TreeEntry } from '../api/types';
const props = defineProps<{
  files: TreeEntry[];
  selected: string;
  busy: boolean;
}>();
const emit = defineEmits<{ select: [entry: TreeEntry] }>();
const sorted = computed(() =>
  [...props.files].sort((a, b) =>
    a.segments.join('/').localeCompare(b.segments.join('/')),
  ),
);
</script>
<template>
  <nav aria-label="Workspace files" class="file-tree">
    <ul class="my-3 mb-6 list-none p-0">
      <li
        v-for="entry in sorted"
        :key="entry.segments.join('/')"
        :style="{ paddingLeft: `${(entry.segments.length - 1) * 16}px` }"
      >
        <span v-if="entry.kind === 'directory'" aria-hidden="true">▸ </span>
        <button
          class="btn btn-ghost max-w-full justify-start text-left font-normal wrap-anywhere aria-[current=true]:bg-base-300 aria-[current=true]:font-semibold"
          :disabled="busy"
          :aria-current="
            selected === entry.segments.join('/') ? 'true' : undefined
          "
          :title="entry.segments.join('/')"
          @click="emit('select', entry)"
        >
          {{ entry.name }}
        </button>
      </li>
    </ul>
  </nav>
</template>
