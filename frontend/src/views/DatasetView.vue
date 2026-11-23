<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api/client';
import type { Dataset, DatasetColumn, DatasetRow } from '../api/types';
import ScalarInput from '../components/ScalarInput.vue';

const route = useRoute();
const router = useRouter();
const id = typeof route.params.id === 'string' ? route.params.id : '';
const base = id ? `/api/datasets/${encodeURIComponent(id)}` : '/api/datasets';
type DraftColumn = Omit<DatasetColumn, 'id'> & { id?: string };
const types = {
  text: 'Text',
  longtext: 'Long text',
  number: 'Number',
  boolean: 'Boolean',
};
function blankColumn(): DraftColumn {
  return { label: '', type: 'text', optional: false };
}

const dataset = ref<Dataset>();
const name = ref('');
const columns = ref<DraftColumn[]>([blankColumn()]);
const showSchema = ref(!id);
const loading = ref(Boolean(id));
const busy = ref(false);
const error = ref('');
const status = ref('');
const rows = ref<DatasetRow[]>([]);
const hasRows = ref(false);
const cursors = ref<number[]>([0]);
const nextAfter = ref<number | null>(null);
const editing = ref<DatasetRow | 'new' | null>(null);
const rowForm = ref<HTMLFormElement>();
const cells = ref<Record<string, string>>({});
const pendingDelete = ref<DatasetRow | 'dataset' | null>(null);
const csv = ref<File | null>(null);
const fileInput = ref<HTMLInputElement>();
const columnLimit = 100;

function resetSchema() {
  name.value = dataset.value?.name ?? '';
  columns.value = dataset.value?.columns.map((column) => ({ ...column })) ?? [
    blankColumn(),
  ];
}

async function page(after = 0) {
  const query = after ? `?after=${after}` : '';
  const result = await api<{ rows: DatasetRow[]; nextAfter: number | null }>(
    `${base}/rows${query}`,
  );
  rows.value = result.rows;
  nextAfter.value = result.nextAfter;
  if (!after) hasRows.value = rows.value.length > 0;
}

async function load() {
  if (!id) return;
  error.value = '';
  loading.value = true;
  try {
    const { dataset: found } = await api<{ dataset: Dataset }>(base);
    await page();
    dataset.value = found;
    resetSchema();
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function perform(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  status.value = '';
  try {
    await action();
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}

function saveSchema() {
  return perform(async () => {
    const { dataset: saved } = await api<{ dataset: Dataset }>(
      base,
      id ? 'PATCH' : 'POST',
      { name: name.value, columns: columns.value },
    );
    if (!id) {
      await router.replace(`/datasets/${saved.id}`);
      return;
    }
    dataset.value = saved;
    resetSchema();
    showSchema.value = false;
    status.value = 'Dataset settings saved.';
  });
}

async function editRow(row: DatasetRow | 'new') {
  cells.value = Object.fromEntries(
    dataset.value!.columns.map(({ id }) => [
      id,
      row === 'new' ? '' : String(row.values[id] ?? ''),
    ]),
  );
  editing.value = row;
  await nextTick();
  rowForm.value?.querySelector<HTMLElement>('input, textarea, select')?.focus();
}

async function firstPage() {
  await page();
  cursors.value = [0];
}

function saveRow() {
  return perform(async () => {
    if (!editing.value || !dataset.value) return;
    const values: DatasetRow['values'] = {};
    for (const column of dataset.value.columns) {
      const raw = cells.value[column.id] ?? '';
      if (raw === '' && column.optional) continue;
      if (column.type === 'number') {
        const value = Number(raw);
        if (!raw.trim() || !Number.isFinite(value))
          throw new Error(`${column.label} must be a finite number.`);
        values[column.id] = value;
      } else if (column.type === 'boolean') {
        if (raw !== 'true' && raw !== 'false')
          throw new Error(`Choose a value for ${column.label}.`);
        values[column.id] = raw === 'true';
      } else {
        values[column.id] = raw;
      }
    }
    const row = editing.value;
    await api(
      row === 'new' ? `${base}/rows` : `${base}/rows/${row.id}`,
      row === 'new' ? 'POST' : 'PATCH',
      { values },
    );
    editing.value = null;
    status.value = row === 'new' ? 'Row added.' : 'Row saved.';
    if (row === 'new') await firstPage();
    else await page(cursors.value.at(-1));
  });
}

function changePage(forward: boolean) {
  return perform(async () => {
    const cursor = forward ? nextAfter.value : cursors.value.at(-2);
    if (cursor == null) return;
    await page(cursor);
    if (forward) cursors.value.push(cursor);
    else cursors.value.pop();
  });
}

function importCsv() {
  return perform(async () => {
    if (!csv.value) return;
    const form = new FormData();
    form.append('file', csv.value);
    const { imported } = await api<{ imported: number }>(
      `${base}/import`,
      'POST',
      form,
    );
    csv.value = null;
    if (fileInput.value) fileInput.value.value = '';
    status.value = `Imported ${imported} ${imported === 1 ? 'row' : 'rows'}.`;
    await firstPage();
  });
}

function remove() {
  return perform(async () => {
    const target = pendingDelete.value;
    if (!target) return;
    await api(
      target === 'dataset' ? base : `${base}/rows/${target.id}`,
      'DELETE',
    );
    pendingDelete.value = null;
    if (target === 'dataset') {
      await router.replace('/datasets');
    } else {
      if (editing.value === target) editing.value = null;
      status.value = 'Row deleted.';
      await firstPage();
    }
  });
}
</script>

<template>
  <RouterLink to="/datasets" class="text-sm underline underline-offset-4"
    >Datasets</RouterLink
  >
  <div class="mt-2 flex flex-wrap items-center justify-between gap-3">
    <h1 class="min-w-0 [overflow-wrap:anywhere]">
      {{ id ? (dataset?.name ?? 'Dataset') : 'New dataset' }}
    </h1>
    <div v-if="dataset" class="flex flex-wrap gap-2">
      <button
        class="btn btn-outline"
        type="button"
        :disabled="busy"
        :aria-expanded="showSchema"
        aria-controls="dataset-schema"
        @click="
          resetSchema();
          showSchema = !showSchema;
        "
      >
        {{ showSchema ? 'Close settings' : 'Dataset settings' }}
      </button>
      <button
        class="btn btn-ghost"
        type="button"
        :disabled="busy"
        @click="pendingDelete = 'dataset'"
      >
        Delete dataset
      </button>
    </div>
  </div>
  <p v-if="loading" role="status">Loading dataset…</p>
  <p v-if="error" role="alert" class="mt-3 text-error">
    {{ error }}
    <button
      v-if="id && !dataset && !loading"
      type="button"
      class="btn btn-sm"
      @click="load"
    >
      Retry
    </button>
  </p>
  <p v-if="status" role="status" class="mt-3">{{ status }}</p>

  <section
    v-if="pendingDelete"
    aria-label="Confirm deletion"
    class="my-4 rounded-box border border-outline p-4"
  >
    <h2>
      {{
        pendingDelete === 'dataset'
          ? 'Delete this dataset and its rows?'
          : 'Delete this row?'
      }}
    </h2>
    <div class="mt-3 flex gap-2">
      <button
        class="btn btn-error"
        type="button"
        :disabled="busy"
        @click="remove"
      >
        Confirm deletion
      </button>
      <button
        class="btn"
        type="button"
        :disabled="busy"
        @click="pendingDelete = null"
      >
        Cancel
      </button>
    </div>
  </section>

  <form
    v-if="showSchema"
    id="dataset-schema"
    class="my-5 max-w-4xl rounded-box border border-outline p-4 workspace:p-6"
    @submit.prevent="saveSchema"
  >
    <fieldset :disabled="busy" class="grid gap-4">
      <label class="grid max-w-md gap-1" for="dataset-name">
        Dataset name
        <input
          id="dataset-name"
          v-model="name"
          class="input w-full"
          maxlength="200"
          required
        />
      </label>
      <h2>Columns</h2>
      <p v-if="hasRows" class="text-sm text-muted">
        You can rename columns while the dataset contains rows.
      </p>
      <fieldset
        v-for="(column, index) in columns"
        :key="column.id ?? index"
        class="grid min-w-0 gap-3 border-t border-outline pt-3 workspace:grid-cols-[minmax(0,1fr)_minmax(8rem,0.5fr)_auto_auto] workspace:items-end"
      >
        <legend class="text-sm font-semibold">Column {{ index + 1 }}</legend>
        <label class="grid gap-1" :for="`column-label-${index}`">
          Name
          <input
            :id="`column-label-${index}`"
            v-model="column.label"
            class="input w-full"
            maxlength="200"
            required
          />
        </label>
        <label class="grid gap-1" :for="`column-type-${index}`">
          Type
          <select
            :id="`column-type-${index}`"
            v-model="column.type"
            class="select w-full"
            :disabled="hasRows"
          >
            <option v-for="(label, value) in types" :key="value" :value="value">
              {{ label }}
            </option>
          </select>
        </label>
        <label class="flex min-h-10 items-center gap-2">
          <input
            v-model="column.optional"
            type="checkbox"
            class="checkbox"
            :disabled="hasRows"
          />
          Optional
        </label>
        <button
          v-if="!hasRows"
          class="btn btn-ghost"
          type="button"
          :disabled="columns.length === 1"
          :aria-label="`Remove column ${index + 1}`"
          @click="columns.splice(index, 1)"
        >
          Remove
        </button>
      </fieldset>
      <div class="flex flex-wrap gap-2 border-t border-outline pt-4">
        <button
          v-if="!hasRows"
          class="btn btn-outline"
          type="button"
          :disabled="columns.length >= columnLimit"
          @click="columns.push(blankColumn())"
        >
          Add column
        </button>
        <button class="btn btn-primary">
          {{ id ? 'Save settings' : 'Create dataset' }}
        </button>
      </div>
    </fieldset>
  </form>

  <section v-if="dataset" aria-labelledby="dataset-rows-title" class="mt-6">
    <h2 id="dataset-rows-title">Rows</h2>
    <form
      v-if="editing"
      id="dataset-row"
      ref="rowForm"
      class="my-4 max-w-3xl rounded-box border border-outline p-4"
      @submit.prevent="saveRow"
    >
      <fieldset :disabled="busy" class="grid gap-3">
        <legend class="font-semibold">
          {{ editing === 'new' ? 'New row' : `Edit row ${editing.position}` }}
        </legend>
        <div
          v-for="column in dataset.columns"
          :key="column.id"
          class="grid gap-1"
        >
          <label :for="`dataset-cell-${column.id}`">
            {{ column.label
            }}<span v-if="column.optional" class="text-sm text-muted">
              (optional)</span
            >
          </label>
          <ScalarInput
            :id="`dataset-cell-${column.id}`"
            v-model="cells[column.id]"
            :type="column.type"
            :required="
              !column.optional &&
              (column.type === 'number' || column.type === 'boolean')
            "
          />
        </div>
        <div class="flex gap-2">
          <button class="btn btn-primary">Save row</button>
          <button class="btn" type="button" @click="editing = null">
            Cancel
          </button>
        </div>
      </fieldset>
    </form>
    <div
      class="mt-4 max-h-[28rem] overflow-auto rounded-box border border-outline"
      role="region"
      aria-label="Dataset rows"
      tabindex="0"
    >
      <table
        class="table [&_td]:px-2 [&_th]:px-2 workspace:[&_td]:px-4 workspace:[&_th]:px-4"
      >
        <thead>
          <tr>
            <th scope="col" class="w-px whitespace-nowrap">Position</th>
            <th
              v-for="column in dataset.columns"
              :key="column.id"
              scope="col"
              :class="{ 'text-right': column.type === 'number' }"
            >
              {{ column.label }}
              <span class="block text-xs font-normal text-muted">{{
                types[column.type]
              }}</span>
            </th>
            <th scope="col" class="w-px whitespace-nowrap">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.id">
            <th scope="row" class="tabular-nums">{{ row.position }}</th>
            <td
              v-for="column in dataset.columns"
              :key="column.id"
              class="min-w-16 max-w-72 workspace:min-w-28"
              :class="{ 'text-right tabular-nums': column.type === 'number' }"
            >
              <span
                v-if="row.values[column.id] === undefined"
                class="text-muted"
                aria-label="Unset"
                >—</span
              >
              <span
                v-else
                class="whitespace-pre-wrap [overflow-wrap:anywhere]"
                >{{ row.values[column.id] }}</span
              >
            </td>
            <td>
              <div
                class="flex flex-col items-start workspace:flex-row workspace:gap-1"
              >
                <button
                  class="btn btn-ghost btn-sm"
                  type="button"
                  :disabled="busy"
                  :aria-label="`Edit row ${row.position}`"
                  @click="editRow(row)"
                >
                  Edit
                </button>
                <button
                  class="btn btn-ghost btn-sm"
                  type="button"
                  :disabled="busy"
                  :aria-label="`Delete row ${row.position}`"
                  @click="pendingDelete = row"
                >
                  Delete
                </button>
              </div>
            </td>
          </tr>
          <tr>
            <td :colspan="dataset.columns.length + 2" class="p-0!">
              <button
                type="button"
                class="btn btn-ghost w-full rounded-none"
                :disabled="busy"
                @click="editRow('new')"
              >
                <i class="fa-solid fa-plus" aria-hidden="true"></i>
                Add new entry
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <nav
      v-if="cursors.length > 1 || nextAfter !== null"
      aria-label="Row pages"
      class="mt-3 flex items-center gap-3"
    >
      <button
        class="btn btn-sm"
        type="button"
        :disabled="busy || cursors.length === 1"
        @click="changePage(false)"
      >
        Previous
      </button>
      <span>Page {{ cursors.length }}</span>
      <button
        class="btn btn-sm"
        type="button"
        :disabled="busy || nextAfter === null"
        @click="changePage(true)"
      >
        Next
      </button>
    </nav>
  </section>

  <form
    v-if="dataset"
    id="dataset-import"
    class="mt-6 border-t border-outline pt-5"
    @submit.prevent="importCsv"
  >
    <fieldset :disabled="busy">
      <legend class="font-semibold">Import CSV</legend>
      <p id="dataset-csv-help" class="mb-3 text-sm text-muted">
        Use column names as headers. Up to 5 MiB and 1,000 rows.
      </p>
      <div class="flex flex-wrap items-end gap-2">
        <label class="grid min-w-0 gap-1" for="dataset-csv">
          CSV file
          <input
            id="dataset-csv"
            ref="fileInput"
            type="file"
            accept=".csv,text/csv"
            class="file-input max-w-full"
            aria-describedby="dataset-csv-help"
            @change="
              csv = ($event.target as HTMLInputElement).files?.[0] ?? null
            "
          />
        </label>
        <button class="btn btn-outline" :disabled="!csv">Import rows</button>
      </div>
    </fieldset>
  </form>
</template>
