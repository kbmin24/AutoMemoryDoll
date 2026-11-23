<script setup lang="ts">
import ParentLink from '../components/ParentLink.vue';
import { computed, nextTick, onMounted, ref } from 'vue';
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
const tabs = [
  { id: 'rows', label: 'Rows' },
  { id: 'import', label: 'Import CSV' },
  { id: 'settings', label: 'Database Settings' },
] as const;
type DatasetTab = (typeof tabs)[number]['id'];
const activeTab = ref<DatasetTab>('rows');
const loading = ref(Boolean(id));
const busy = ref(false);
const movingRow = ref(false);
const error = ref('');
const status = ref('');
const rows = ref<DatasetRow[]>([]);
const hasRows = ref(false);
const cursors = ref([{ after: '', offset: 0 }]);
const pageOffset = computed(() => cursors.value.at(-1)!.offset);
const nextAfter = ref<string | null>(null);
const draggedIndex = ref<number | null>(null);
const dropIndex = ref<number | null>(null);
const editing = ref<DatasetRow | 'new' | null>(null);
const tableRows = computed(() =>
  editing.value === 'new' ? [...rows.value, 'new' as const] : rows.value,
);
const inlineRowForm = ref<HTMLFormElement>();
const cells = ref<Record<string, string>>({});
const pendingDelete = ref<DatasetRow | 'dataset' | null>(null);
const csv = ref<File | null>(null);
const fileInput = ref<HTMLInputElement>();
const columnLimit = 100;

function selectTab(tab: DatasetTab) {
  if (activeTab.value === tab) return;
  activeTab.value = tab;
  pendingDelete.value = null;
}

function navigateTabs(event: KeyboardEvent) {
  const index = tabs.findIndex(({ id }) => id === activeTab.value);
  const targets: Record<string, number> = {
    ArrowLeft: (index + tabs.length - 1) % tabs.length,
    ArrowRight: (index + 1) % tabs.length,
    Home: 0,
    End: tabs.length - 1,
  };
  const tab = tabs[targets[event.key]];
  if (!tab) return;
  event.preventDefault();
  selectTab(tab.id);
  document.getElementById(`dataset-tab-${tab.id}`)?.focus();
}

function resetSchema() {
  name.value = dataset.value?.name ?? '';
  columns.value = dataset.value?.columns.map((column) => ({ ...column })) ?? [
    blankColumn(),
  ];
}

async function page(after = '') {
  const query = after ? `?after=${encodeURIComponent(after)}` : '';
  const result = await api<{ rows: DatasetRow[]; nextAfter: string | null }>(
    `${base}/rows${query}`,
  );
  clearDrag();
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
  inlineRowForm.value
    ?.querySelector<HTMLElement>('input, textarea, select')
    ?.focus();
}

async function firstPage() {
  await page();
  cursors.value = [{ after: '', offset: 0 }];
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
    else await page(cursors.value.at(-1)?.after);
  });
}

function changePage(forward: boolean) {
  return perform(async () => {
    if (forward) {
      const after = nextAfter.value;
      if (after === null) return;
      const offset = pageOffset.value + rows.value.length;
      await page(after);
      cursors.value.push({ after, offset });
    } else {
      const previous = cursors.value.at(-2);
      if (!previous) return;
      await page(previous.after);
      cursors.value.pop();
    }
  });
}

function clearDrag() {
  draggedIndex.value = null;
  dropIndex.value = null;
}

function startDrag(event: DragEvent, index: number) {
  if (busy.value) {
    event.preventDefault();
    return;
  }
  draggedIndex.value = index;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(
      'text/plain',
      String(rows.value[index].position),
    );
    const handle = event.currentTarget as HTMLElement;
    const row = handle.closest('tr');
    if (row) {
      const { left, top } = row.getBoundingClientRect();
      event.dataTransfer.setDragImage(
        row,
        event.clientX - left,
        event.clientY - top,
      );
    }
  }
}

function allowDrop(event: DragEvent, index: number) {
  if (busy.value || draggedIndex.value === null || draggedIndex.value === index)
    return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  dropIndex.value = index;
}

function dropRow(index: number) {
  const source = draggedIndex.value;
  clearDrag();
  if (busy.value || source === null || source === index) return;
  const target = rows.value[index].id;
  void moveRow(
    rows.value[source],
    source > index ? { beforeRowId: target } : { afterRowId: target },
  );
}

function moveRow(
  row: DatasetRow,
  move: { beforeRowId: string } | { afterRowId: string },
) {
  return perform(async () => {
    movingRow.value = true;
    try {
      const result = await api<{ rebalanced?: boolean }>(
        `${base}/rows/${encodeURIComponent(row.id)}/order`,
        'PATCH',
        move,
      );
      // Rebalancing can invalidate saved cursors.
      if (result.rebalanced) await firstPage();
      else await page(cursors.value.at(-1)?.after);
    } finally {
      movingRow.value = false;
    }
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
      if (editing.value !== 'new' && editing.value?.id === target.id) {
        editing.value = null;
      }
      status.value = 'Row deleted.';
      await firstPage();
    }
  });
}
</script>

<template>
  <ParentLink to="/datasets" label="Datasets" />
  <h1 class="min-w-0 [overflow-wrap:anywhere]">
    {{ id ? (dataset?.name ?? 'Dataset') : 'New dataset' }}
  </h1>
  <div
    v-if="dataset"
    class="tabs tabs-border mt-4 flex-nowrap overflow-x-auto"
    role="tablist"
    aria-label="Dataset"
    @keydown="navigateTabs"
  >
    <button
      v-for="tab in tabs"
      :id="`dataset-tab-${tab.id}`"
      :key="tab.id"
      type="button"
      role="tab"
      class="tab shrink-0 whitespace-nowrap"
      :class="{ 'tab-active': activeTab === tab.id }"
      :aria-controls="`dataset-panel-${tab.id}`"
      :aria-selected="activeTab === tab.id"
      :tabindex="activeTab === tab.id ? 0 : -1"
      @click="selectTab(tab.id)"
    >
      {{ tab.label }}
    </button>
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

  <section
    v-if="dataset || !id"
    v-show="!id || activeTab === 'settings'"
    id="dataset-panel-settings"
    :role="id ? 'tabpanel' : undefined"
    :aria-labelledby="id ? 'dataset-tab-settings' : undefined"
  >
    <form
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
              <option
                v-for="(label, value) in types"
                :key="value"
                :value="value"
              >
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
    <button
      v-if="dataset"
      class="btn btn-error btn-outline"
      type="button"
      :disabled="busy"
      @click="pendingDelete = 'dataset'"
    >
      Delete dataset
    </button>
  </section>

  <section
    v-if="dataset"
    v-show="activeTab === 'rows'"
    id="dataset-panel-rows"
    role="tabpanel"
    aria-labelledby="dataset-tab-rows"
    class="mt-4"
  >
    <form ref="inlineRowForm" class="relative mt-4" @submit.prevent="saveRow">
      <div
        class="max-h-[28rem] overflow-auto rounded-box border border-outline"
        role="region"
        aria-label="Dataset rows"
        :aria-busy="movingRow"
        tabindex="0"
      >
        <table
          class="table [&_td]:px-2 [&_th]:px-2 workspace:[&_td]:px-4 workspace:[&_th]:px-4"
        >
          <thead>
            <tr>
              <th scope="col" class="w-px whitespace-nowrap">#</th>
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
              <td aria-hidden="true" class="w-full p-0!"></td>
              <th scope="col" class="w-px whitespace-nowrap">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(row, index) in tableRows"
              :key="row === 'new' ? 'new' : row.id"
              :class="{
                'bg-base-200': dropIndex === index,
                'opacity-50': draggedIndex === index,
              }"
              @dragover="row !== 'new' && allowDrop($event, index)"
              @drop.prevent="row !== 'new' && dropRow(index)"
            >
              <th scope="row" class="whitespace-nowrap tabular-nums">
                <span v-if="row === 'new'">New</span>
                <template v-else>
                  <span
                    :draggable="!busy && !editing"
                    :title="`Drag row ${row.position}`"
                    class="mr-2 inline-flex cursor-grab p-1 active:cursor-grabbing"
                    aria-hidden="true"
                    @dragstart="startDrag($event, index)"
                    @dragend="clearDrag"
                  >
                    <i class="fa-solid fa-grip-vertical text-muted"></i>
                  </span>
                  {{ pageOffset + index + 1 }}
                </template>
              </th>
              <td
                v-for="column in dataset.columns"
                :key="column.id"
                class="min-w-16 max-w-72 workspace:min-w-28"
                :class="{ 'text-right tabular-nums': column.type === 'number' }"
              >
                <ScalarInput
                  v-if="
                    row === 'new' ||
                    (editing !== 'new' && editing?.id === row.id)
                  "
                  :id="`dataset-inline-cell-${column.id}`"
                  v-model="cells[column.id]"
                  :aria-label="column.label"
                  :type="column.type"
                  :disabled="busy"
                  :required="
                    !column.optional &&
                    (column.type === 'number' || column.type === 'boolean')
                  "
                />
                <span
                  v-else-if="row.values[column.id] === undefined"
                  class="text-muted"
                  aria-label="Unset"
                  >—</span
                >
                <span
                  v-else
                  class="inline-block w-max max-w-72 whitespace-pre-wrap [overflow-wrap:anywhere]"
                  >{{ row.values[column.id] }}</span
                >
              </td>
              <td aria-hidden="true" class="p-0!"></td>
              <td>
                <div
                  v-if="
                    row === 'new' ||
                    (editing !== 'new' && editing?.id === row.id)
                  "
                  class="flex flex-col items-start workspace:flex-row workspace:gap-1"
                >
                  <button
                    class="btn btn-primary btn-sm"
                    type="submit"
                    :disabled="busy"
                  >
                    Save
                  </button>
                  <button
                    class="btn btn-ghost btn-sm"
                    type="button"
                    :disabled="busy"
                    :aria-label="
                      row === 'new'
                        ? 'Cancel new row'
                        : `Cancel editing row ${row.position}`
                    "
                    @click="editing = null"
                  >
                    Cancel
                  </button>
                </div>
                <div
                  v-else
                  class="flex flex-col items-start workspace:flex-row workspace:gap-1"
                >
                  <button
                    class="btn btn-ghost btn-sm"
                    type="button"
                    :disabled="busy || !!editing"
                    :aria-label="`Edit row ${row.position}`"
                    @click="editRow(row)"
                  >
                    Edit
                  </button>
                  <button
                    class="btn btn-ghost btn-sm"
                    type="button"
                    :disabled="busy || !!editing"
                    :aria-label="`Delete row ${row.position}`"
                    @click="pendingDelete = row"
                  >
                    Delete
                  </button>
                </div>
              </td>
            </tr>
            <tr v-if="editing !== 'new'">
              <td :colspan="dataset.columns.length + 3" class="p-0!">
                <button
                  type="button"
                  class="btn btn-ghost w-full rounded-none"
                  :disabled="busy || !!editing"
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
      <div
        v-if="movingRow"
        role="status"
        aria-label="Moving row"
        class="absolute inset-0 z-10 grid place-items-center rounded-box bg-base-100/65"
      >
        <span
          class="loading loading-spinner loading-lg"
          aria-hidden="true"
        ></span>
      </div>
    </form>
    <nav
      v-if="cursors.length > 1 || nextAfter !== null"
      aria-label="Row pages"
      class="mt-3 flex items-center gap-3"
    >
      <button
        class="btn btn-sm"
        type="button"
        :disabled="busy || !!editing || cursors.length === 1"
        @click="changePage(false)"
      >
        Previous
      </button>
      <span>Page {{ cursors.length }}</span>
      <button
        class="btn btn-sm"
        type="button"
        :disabled="busy || !!editing || nextAfter === null"
        @click="changePage(true)"
      >
        Next
      </button>
    </nav>
  </section>

  <section
    v-if="dataset"
    v-show="activeTab === 'import'"
    id="dataset-panel-import"
    role="tabpanel"
    aria-labelledby="dataset-tab-import"
    class="mt-5"
  >
    <form id="dataset-import" @submit.prevent="importCsv">
      <fieldset :disabled="busy">
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
          <button class="btn btn-outline" :disabled="!csv || !!editing">
            Import rows
          </button>
        </div>
      </fieldset>
    </form>
  </section>
</template>
