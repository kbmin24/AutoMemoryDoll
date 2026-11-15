<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { FieldType } from '../api/types';
import ScalarInput from './ScalarInput.vue';
const props = defineProps<{
  id: string;
  label: string;
  itemType: FieldType;
  optional: boolean;
  disabled?: boolean;
  showValidation?: boolean;
}>();
const values = defineModel<string[]>({ required: true });
const missing = computed(
  () =>
    props.showValidation &&
    ((!props.optional && values.value.length === 0) ||
      values.value.some((value) => !value.trim())),
);
const container = ref<HTMLFieldSetElement>();
const addButton = ref<HTMLButtonElement>();
let nextId = 0;
const itemIds = ref<number[]>([]);
watch(
  () => values.value.length,
  (length) => {
    while (itemIds.value.length < length) itemIds.value.push(nextId++);
    itemIds.value.length = length;
  },
  { immediate: true, flush: 'sync' },
);
async function focusItem(index: number) {
  await nextTick();
  const inputs = container.value?.querySelectorAll<HTMLElement>(
    'input, textarea, select',
  );
  if (inputs?.length) inputs[Math.min(index, inputs.length - 1)].focus();
  else addButton.value?.focus();
}
function add() {
  if (props.disabled) return;
  const index = values.value.length;
  values.value = [...values.value, ''];
  void focusItem(index);
}
function remove(index: number) {
  if (props.disabled) return;
  itemIds.value.splice(index, 1);
  values.value = values.value.filter((_, position) => position !== index);
  void focusItem(index);
}
function update(index: number, value: string) {
  if (props.disabled) return;
  values.value = values.value.map((item, position) =>
    position === index ? value : item,
  );
}
</script>
<template>
  <fieldset :id="id" ref="container" :disabled="disabled" class="min-w-0">
    <legend class="mb-2 text-sm font-semibold">
      {{ label }}
      <span v-if="optional" class="font-normal text-muted">(optional)</span>
      <span
        v-if="missing"
        :id="`${id}-required`"
        class="ml-2 font-normal text-error"
        >Required</span
      >
    </legend>
    <div
      class="rounded-box border bg-base-100 p-4"
      :class="missing ? 'border-error' : 'border-outline'"
    >
      <div v-for="(itemId, index) in itemIds" :key="itemId" class="mb-4">
        <label class="block" :for="`${id}-${itemId}`"
          >Item {{ index + 1 }}
          <span
            v-if="showValidation && !values[index].trim()"
            :id="`${id}-${itemId}-required`"
            class="ml-2 font-normal text-error"
            >Required</span
          >
        </label>
        <div class="flex min-w-0 items-start gap-2">
          <div class="min-w-0 flex-1">
            <ScalarInput
              :id="`${id}-${itemId}`"
              :type="itemType"
              :model-value="values[index]"
              :disabled="disabled"
              required
              :show-validation="showValidation"
              @update:model-value="update(index, $event)"
            />
          </div>
          <button
            type="button"
            class="btn shrink-0"
            data-remove-item
            :aria-label="`Remove ${label} item ${index + 1}`"
            :disabled="disabled"
            @click="remove(index)"
          >
            Remove
          </button>
        </div>
      </div>
      <button
        ref="addButton"
        type="button"
        class="btn"
        data-add-item
        :aria-label="`Add item to ${label}`"
        :disabled="disabled"
        @click="add"
      >
        Add item
      </button>
    </div>
  </fieldset>
</template>
