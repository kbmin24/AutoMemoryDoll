<script setup lang="ts">
import type { ShapeField } from '../api/types';
import ScalarInput from './ScalarInput.vue';
import ListInput from './ListInput.vue';
const props = defineProps<{
  fields: ShapeField[];
  disabled?: boolean;
  showValidation?: boolean;
  prefix?: string;
  boundFields?: ReadonlySet<string>;
}>();
type ObjectRow = Record<string, string>;
const values = defineModel<Record<string, string | string[] | ObjectRow[]>>({
  required: true,
});
function fieldId(variable: string) {
  return `${props.prefix ?? 'field'}-${variable}`;
}

function fieldValue(variable: string) {
  return Object.hasOwn(values.value, variable)
    ? values.value[variable]
    : undefined;
}

function rows(variable: string) {
  return (fieldValue(variable) ?? []) as ObjectRow[];
}

function setRow(variable: string, index: number, row: ObjectRow) {
  values.value[variable] = rows(variable).map((item, position) =>
    position === index ? row : item,
  );
}

function removeRow(variable: string, index: number) {
  values.value[variable] = rows(variable).filter(
    (_, position) => position !== index,
  );
}
</script>
<template>
  <div class="grid gap-5">
    <template v-for="field in fields" :key="field.variable">
      <ListInput
        v-if="field.type === 'list'"
        :id="fieldId(field.variable)"
        :label="field.label"
        :item-type="field.itemType"
        :optional="field.optional"
        :disabled="disabled"
        :show-validation="showValidation"
        :model-value="(fieldValue(field.variable) ?? []) as string[]"
        @update:model-value="values = { ...values, [field.variable]: $event }"
      />
      <fieldset
        v-else-if="field.type === 'object-list'"
        :disabled="disabled"
        class="min-w-0"
      >
        <legend class="mb-2 text-sm font-semibold">
          {{ field.label }}
          <span v-if="field.optional" class="font-normal text-muted"
            >(optional)</span
          >
          <span
            v-else-if="
              showValidation &&
              !boundFields?.has(field.variable) &&
              !rows(field.variable).length
            "
            class="ml-2 text-error"
            >Required</span
          >
        </legend>
        <slot name="object-list-source" :field="field" />
        <template v-if="!boundFields?.has(field.variable)">
          <fieldset
            v-for="(row, index) in rows(field.variable)"
            :key="index"
            class="mb-4 rounded-box border border-outline p-4"
          >
            <legend>Item {{ index + 1 }}</legend>
            <DynamicForm
              :fields="field.properties"
              :prefix="`${fieldId(field.variable)}-${index}`"
              :model-value="row"
              :disabled="disabled"
              :show-validation="showValidation"
              @update:model-value="
                setRow(field.variable, index, $event as ObjectRow)
              "
            />
            <button
              type="button"
              class="btn mt-3"
              :aria-label="`Remove ${field.label} item ${index + 1}`"
              @click="removeRow(field.variable, index)"
            >
              Remove
            </button>
          </fieldset>
          <button
            type="button"
            class="btn"
            :aria-label="`Add item to ${field.label}`"
            @click="values[field.variable] = [...rows(field.variable), {}]"
          >
            Add item
          </button>
        </template>
      </fieldset>
      <div v-else>
        <label class="block" :for="fieldId(field.variable)">
          {{ field.label }}
          <span v-if="field.optional" class="font-normal text-muted"
            >(optional)</span
          >
          <span
            v-else-if="
              showValidation && !String(fieldValue(field.variable) ?? '').trim()
            "
            :id="`${fieldId(field.variable)}-required`"
            class="ml-2 font-normal text-error"
            >Required</span
          >
        </label>
        <ScalarInput
          :id="fieldId(field.variable)"
          :type="field.type"
          :model-value="(fieldValue(field.variable) ?? '') as string"
          :disabled="disabled"
          :show-validation="showValidation"
          :required="!field.optional"
          @update:model-value="values = { ...values, [field.variable]: $event }"
        />
      </div>
    </template>
  </div>
</template>
