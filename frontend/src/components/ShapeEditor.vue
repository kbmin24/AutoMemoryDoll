<script setup lang="ts">
import type {
  FieldType,
  Template,
  ShapeField,
  ScalarField,
} from '../api/types';
const manifest = defineModel<Template['manifest']>({ required: true });
defineProps<{ disabled?: boolean; propertiesOnly?: boolean }>();
function enable(event: Event) {
  manifest.value = {
    version: 1,
    shape: (event.target as HTMLInputElement).checked
      ? { fields: [{ variable: '', label: '', type: 'text', optional: false }] }
      : null,
  };
}
function update(
  index: number,
  key: keyof ShapeField | 'itemType',
  value: string | boolean,
) {
  const fields = manifest.value.shape!.fields.map((field, position) =>
    position === index ? { ...field, [key]: value } : field,
  );
  manifest.value = { version: 1, shape: { fields } };
}
function changeType(index: number, type: ShapeField['type']) {
  const { variable, label, optional } = manifest.value.shape!.fields[index];
  // A list draft stays unsaveable until the author chooses its base type.
  const field: ShapeField =
    type === 'list'
      ? { variable, label, optional, type, itemType: '' as FieldType }
      : type === 'object-list'
        ? {
            variable,
            label,
            optional,
            type,
            properties: [
              { variable: '', label: '', type: 'text', optional: false },
            ],
          }
        : { variable, label, optional, type };
  const fields = [...manifest.value.shape!.fields];
  fields[index] = field;
  manifest.value = { version: 1, shape: { fields } };
}
function updateProperties(index: number, shape: Template['manifest']) {
  const fields = [...manifest.value.shape!.fields];
  const field = fields[index];
  if (field.type !== 'object-list') return;
  fields[index] = {
    ...field,
    properties: (shape.shape?.fields ?? []) as ScalarField[],
  };
  manifest.value = { version: 1, shape: { fields } };
}
function add() {
  manifest.value = {
    version: 1,
    shape: {
      fields: [
        ...manifest.value.shape!.fields,
        { variable: '', label: '', type: 'text', optional: false },
      ],
    },
  };
}
function move(index: number, offset: number) {
  const fields = [...manifest.value.shape!.fields];
  const [field] = fields.splice(index, 1);
  fields.splice(index + offset, 0, field!);
  manifest.value = { version: 1, shape: { fields } };
}
function remove(index: number) {
  manifest.value = {
    version: 1,
    shape: {
      fields: manifest.value.shape!.fields.filter(
        (_, position) => position !== index,
      ),
    },
  };
}
</script>
<template>
  <fieldset
    :disabled="disabled"
    class="my-4 w-full min-w-0 rounded-box border border-outline p-4 workspace:p-5"
  >
    <legend>{{ propertiesOnly ? 'Object properties' : 'Data shape' }}</legend>
    <label v-if="!propertiesOnly" class="mb-2 flex items-center gap-2.5"
      ><input
        class="checkbox checkbox-primary shrink-0"
        type="checkbox"
        aria-label="Define data shape"
        :checked="manifest.shape !== null"
        @change="enable"
      />Define data shape</label
    >
    <p v-if="!manifest.shape">Document creators will enter a JSON object.</p>
    <template v-else>
      <p v-if="!propertiesOnly">
        Define at least one field. Variables must be unique and use letters,
        numbers or underscores, starting with a letter or underscore.
      </p>
      <fieldset
        v-for="(field, index) in manifest.shape.fields"
        :key="index"
        class="my-4 grid min-w-0 grid-cols-1 gap-4 rounded-box border border-outline p-5 workspace:grid-cols-3 [&_input]:mb-0 [&_input]:mt-2 [&_select]:mt-2"
      >
        <legend>Field {{ index + 1 }}</legend>
        <label
          >Variable<input
            class="input mb-5 min-h-[46px] w-full min-w-0"
            :aria-label="`Variable ${index + 1}`"
            :value="field.variable"
            @input="
              update(
                index,
                'variable',
                ($event.target as HTMLInputElement).value,
              )
            "
        /></label>
        <label
          >Display name<input
            class="input mb-5 min-h-[46px] w-full min-w-0"
            :aria-label="`Display name ${index + 1}`"
            maxlength="200"
            :value="field.label"
            @input="
              update(index, 'label', ($event.target as HTMLInputElement).value)
            "
        /></label>
        <label
          >Type<select
            class="select min-h-11 w-full min-w-0"
            :aria-label="`Type ${index + 1}`"
            :value="field.type"
            @change="
              changeType(
                index,
                ($event.target as HTMLSelectElement)
                  .value as ShapeField['type'],
              )
            "
          >
            <option value="text">Text</option>
            <option value="longtext">Long text</option>
            <option value="number">Number</option>
            <option value="boolean">Boolean</option>
            <option v-if="!propertiesOnly" value="list">List</option>
            <option v-if="!propertiesOnly" value="object-list">
              List of objects
            </option>
          </select></label
        >
        <label v-if="field.type === 'list'">
          List item type
          <select
            class="select min-h-11 w-full min-w-0"
            :aria-label="`List item type ${index + 1}`"
            :value="field.itemType"
            required
            @change="
              update(
                index,
                'itemType',
                ($event.target as HTMLSelectElement).value,
              )
            "
          >
            <option value="" disabled>Choose a base type</option>
            <option value="text">Text</option>
            <option value="longtext">Long text</option>
            <option value="number">Number</option>
            <option value="boolean">Boolean</option>
          </select>
        </label>
        <label class="mb-2 flex items-center gap-2.5"
          ><input
            class="checkbox checkbox-primary shrink-0"
            type="checkbox"
            :aria-label="`Optional ${index + 1}`"
            :checked="field.optional"
            @change="
              update(
                index,
                'optional',
                ($event.target as HTMLInputElement).checked,
              )
            "
          />Optional</label
        >
        <ShapeEditor
          v-if="field.type === 'object-list'"
          class="workspace:col-span-3"
          properties-only
          :model-value="{ version: 1, shape: { fields: field.properties } }"
          @update:model-value="updateProperties(index, $event)"
        />
        <div class="actions flex flex-wrap items-start gap-2">
          <button
            class="btn"
            type="button"
            :aria-label="`Move field ${index + 1} up`"
            :disabled="index === 0"
            @click="move(index, -1)"
          >
            Up
          </button>
          <button
            class="btn"
            type="button"
            :aria-label="`Move field ${index + 1} down`"
            :disabled="index === manifest.shape.fields.length - 1"
            @click="move(index, 1)"
          >
            Down
          </button>
          <button
            class="btn"
            type="button"
            :aria-label="`Remove field ${index + 1}`"
            @click="remove(index)"
          >
            Remove
          </button>
        </div>
      </fieldset>
      <button class="btn" type="button" @click="add">
        {{ propertiesOnly ? 'Add property' : 'Add field' }}
      </button>
    </template>
  </fieldset>
</template>
