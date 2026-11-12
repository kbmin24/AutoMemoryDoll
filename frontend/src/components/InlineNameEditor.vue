<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';
const props = defineProps<{
  initialName: string;
  label: string;
  busy: boolean;
}>();
const emit = defineEmits<{ submit: [name: string]; cancel: [] }>();
const name = ref(props.initialName);
const input = ref<HTMLInputElement>();
async function focus() {
  await nextTick();
  input.value?.focus();
}
onMounted(async () => {
  await focus();
  const dot = name.value.lastIndexOf('.');
  input.value?.setSelectionRange(0, dot > 0 ? dot : name.value.length);
});
watch(
  () => props.busy,
  (busy) => {
    if (!busy) void focus();
  },
);
</script>
<template>
  <div class="flex min-w-0 flex-1 items-center">
    <input
      ref="input"
      v-model="name"
      :aria-label="label"
      :placeholder="label"
      class="input input-sm w-full min-w-0"
      :disabled="busy"
      @keydown.enter.stop.prevent="!busy && emit('submit', name)"
      @keydown.esc.stop.prevent="!busy && emit('cancel')"
    />
    <button
      type="button"
      class="btn btn-ghost btn-square size-11 min-h-0 workspace:size-8"
      :disabled="busy"
      aria-label="Confirm name"
      @click.stop="emit('submit', name)"
    >
      <svg aria-hidden="true" viewBox="0 0 16 16" class="h-4 w-4">
        <path
          d="m3 8 3 3 7-7"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
        />
      </svg>
    </button>
    <button
      type="button"
      class="btn btn-ghost btn-square size-11 min-h-0 workspace:size-8"
      :disabled="busy"
      aria-label="Cancel naming"
      @click.stop="emit('cancel')"
    >
      ×
    </button>
  </div>
</template>
