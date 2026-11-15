<script setup lang="ts">
import { computed } from 'vue';
import type { FieldType } from '../api/types';
const props = defineProps<{
  type: FieldType;
  id: string;
  required?: boolean;
  showValidation?: boolean;
  disabled?: boolean;
}>();
const value = defineModel<string>({ required: true });
const missing = computed(
  () => props.showValidation && props.required && !value.value.trim(),
);
</script>
<template>
  <textarea
    v-if="type === 'longtext'"
    :id="id"
    v-model="value"
    class="textarea w-full"
    :class="{ 'textarea-error border-error!': missing }"
    :aria-invalid="missing || undefined"
    :aria-describedby="missing ? `${id}-required` : undefined"
    rows="5"
    :disabled="disabled"
    :required="required"
  />
  <select
    v-else-if="type === 'boolean'"
    :id="id"
    v-model="value"
    class="select w-full"
    :class="{ 'select-error border-error!': missing }"
    :aria-invalid="missing || undefined"
    :aria-describedby="missing ? `${id}-required` : undefined"
    :disabled="disabled"
    :required="required"
  >
    <option value="">{{ required ? 'Choose a value' : 'Unset' }}</option>
    <option value="true">True</option>
    <option value="false">False</option>
  </select>
  <input
    v-else
    :id="id"
    :value="value"
    @input="value = ($event.target as HTMLInputElement).value"
    :type="type === 'number' ? 'number' : 'text'"
    :step="type === 'number' ? 'any' : undefined"
    class="input w-full"
    :class="{ 'input-error border-error!': missing }"
    :aria-invalid="missing || undefined"
    :aria-describedby="missing ? `${id}-required` : undefined"
    :disabled="disabled"
    :required="required"
  />
</template>
