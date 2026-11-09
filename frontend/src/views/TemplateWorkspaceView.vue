<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  onBeforeRouteLeave,
  onBeforeRouteUpdate,
  useRoute,
  useRouter,
} from 'vue-router';
import { api } from '../api/client';
import type { Template, TreeEntry } from '../api/types';
import FileTree from '../components/FileTree.vue';
import TextEditor from '../components/TextEditor.vue';
import ShapeEditor from '../components/ShapeEditor.vue';

const route = useRoute();
const router = useRouter();
const creating = computed(() => !route.params.id);
const base = computed(
  () => `/api/templates/${encodeURIComponent(String(route.params.id))}`,
);
const name = ref('');
const savedName = ref('');
const initialManifest = (): Template['manifest'] => ({
  version: 1,
  shape: {
    fields: [{ variable: '', label: '', type: 'text', optional: false }],
  },
});
const manifest = ref(initialManifest());
const savedManifest = ref(JSON.stringify(manifest.value));
const files = ref<TreeEntry[]>([]);
const selected = ref<TreeEntry | null>(null);
const text = ref('');
const savedText = ref('');
const editable = ref(false);
const destination = ref('');
const upload = ref<File | null>(null);
const tab = ref('files');
const mobilePane = ref('files');
const busy = ref(false);
const loading = ref(false);
const loaded = ref(false);
const error = ref('');
const status = ref('');
const fileDirty = computed(
  () => editable.value && text.value !== savedText.value,
);
const dirty = computed(
  () =>
    (creating.value || loaded.value) &&
    (fileDirty.value ||
      name.value !== savedName.value ||
      JSON.stringify(manifest.value) !== savedManifest.value),
);
const protectedFile = computed(
  () =>
    selected.value?.segments.length === 1 &&
    selected.value.name === 'template.tex',
);
const download = computed(() =>
  selected.value?.kind === 'file'
    ? `${base.value}/files/download?${query(selected.value.segments)}`
    : '',
);

function query(segments: string[]) {
  const params = new URLSearchParams();
  segments.forEach((segment) => params.append('segments', segment));
  return params.toString();
}
function discard() {
  return !dirty.value || window.confirm('Discard unsaved changes?');
}
onBeforeRouteLeave(() => !busy.value && discard());
onBeforeRouteUpdate(() => !busy.value && discard());
function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value || busy.value) {
    event.preventDefault();
    event.returnValue = '';
  }
}
onMounted(() => window.addEventListener('beforeunload', beforeUnload));
onUnmounted(() => window.removeEventListener('beforeunload', beforeUnload));
async function refreshFiles() {
  files.value = (
    await api<{ files: TreeEntry[] }>(`${base.value}/files`)
  ).files;
}
async function load() {
  loaded.value = false;
  selected.value = null;
  editable.value = false;
  text.value = savedText.value = '';
  destination.value = '';
  upload.value = null;
  tab.value = 'files';
  mobilePane.value = 'files';
  error.value = status.value = '';
  name.value = savedName.value = '';
  manifest.value = initialManifest();
  savedManifest.value = JSON.stringify(manifest.value);
  if (creating.value) return;
  loading.value = true;
  try {
    const result = await api<{ template: Template }>(base.value);
    name.value = savedName.value = result.template.name;
    manifest.value = result.template.manifest;
    savedManifest.value = JSON.stringify(manifest.value);
    await refreshFiles();
    loaded.value = true;
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    loading.value = false;
  }
}
watch(() => route.params.id, load, { immediate: true });
async function perform(action: () => Promise<void>, message: string) {
  if (busy.value) return;
  busy.value = true;
  error.value = status.value = '';
  try {
    await action();
    status.value = message;
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
function validateShape() {
  if (!manifest.value.shape) return;
  const fields = manifest.value.shape.fields;
  const seen = new Set<string>();
  if (!fields.length)
    throw new Error('Add at least one field or disable the data shape.');
  for (const field of fields) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field.variable) ||
      seen.has(field.variable)
    ) {
      throw new Error('Field variables must be valid and unique.');
    }
    if (!field.label.trim() || field.label.length > 200)
      throw new Error(
        'Each field needs a display name of up to 200 characters.',
      );
    seen.add(field.variable);
  }
}
async function saveSettings() {
  let createdId: string | undefined;
  await perform(async () => {
    if (!name.value.trim() || name.value.length > 200)
      throw new Error('Enter a template name of up to 200 characters.');
    if (creating.value) {
      validateShape();
      const result = await api<{ template: Template }>(
        '/api/templates',
        'POST',
        { name: name.value, manifest: manifest.value },
      );
      createdId = result.template.id;
      savedManifest.value = JSON.stringify(manifest.value);
    } else {
      await api(base.value, 'PATCH', { name: name.value });
    }
    savedName.value = name.value;
  }, 'Template saved.');
  if (createdId) await router.replace(`/templates/${createdId}/edit`);
}
async function saveShape() {
  await perform(async () => {
    validateShape();
    await api(base.value, 'PATCH', { manifest: manifest.value });
    savedManifest.value = JSON.stringify(manifest.value);
  }, 'Data shape saved.');
}
async function select(entry: TreeEntry) {
  if (fileDirty.value && !window.confirm('Discard unsaved file changes?'))
    return;
  await perform(async () => {
    selected.value = entry;
    editable.value = false;
    text.value = savedText.value = '';
    destination.value = entry.segments.join('/');
    if (entry.kind === 'file') {
      mobilePane.value = 'editor';
      // The server validates UTF-8 and size; file extensions do not determine editability.
      const result = await api<{ text: string }>(
        `${base.value}/files/text?${query(entry.segments)}`,
      );
      text.value = savedText.value = result.text;
      editable.value = true;
    }
  }, '');
}
async function saveFile() {
  if (!selected.value || !editable.value) return;
  await perform(async () => {
    if (new TextEncoder().encode(text.value).length > 1024 * 1024)
      throw new Error('Editable text is limited to 1 MiB.');
    await api(`${base.value}/files/text`, 'PUT', {
      segments: selected.value!.segments,
      text: text.value,
    });
    savedText.value = text.value;
  }, 'File saved.');
}
function pathSegments(value: string) {
  const segments = value.split('/');
  if (
    segments.length > 8 ||
    value.length > 512 ||
    segments.some(
      (segment) =>
        segment.length > 128 ||
        !/^[A-Za-z0-9][A-Za-z0-9 _.\-]*$/.test(segment) ||
        /[. ]$/.test(segment),
    )
  ) {
    throw new Error(
      'Use relative ASCII paths: letters, numbers, spaces, underscores, hyphens and dots; start with a letter or number. Maximum 128 characters per name, 8 levels, 512 characters total.',
    );
  }
  return segments;
}
async function fileAction(
  action: 'file' | 'directory' | 'upload' | 'rename' | 'move' | 'delete',
) {
  if (
    ['rename', 'move', 'delete'].includes(action) &&
    (!selected.value || protectedFile.value)
  )
    return;
  if (fileDirty.value && !window.confirm('Discard unsaved file changes?'))
    return;
  if (
    action === 'delete' &&
    !window.confirm(
      `Delete ${selected.value!.segments.join('/')} and its contents?`,
    )
  )
    return;
  await perform(async () => {
    let to: string[] = [];
    if (action !== 'delete') {
      to = pathSegments(destination.value);
      if (action === 'rename') {
        if (to.length !== 1)
          throw new Error(
            'For Rename, enter only the new name. Use Move for a full destination path.',
          );
        to = [...selected.value!.segments.slice(0, -1), to[0]!];
        pathSegments(to.join('/'));
      }
    }
    if (action === 'file') {
      if (
        files.value.some((entry) => entry.segments.join('/') === to.join('/'))
      )
        throw new Error(
          'That path already exists. Select the file to edit it.',
        );
      await api(`${base.value}/files/text`, 'PUT', { segments: to, text: '' });
    } else if (action === 'directory') {
      await api(`${base.value}/files/directories`, 'POST', { segments: to });
    } else if (action === 'upload') {
      if (!upload.value) throw new Error('Choose a file to upload.');
      if (upload.value.size > 20 * 1024 * 1024)
        throw new Error('Uploads are limited to 20 MiB per file.');
      const body = new FormData();
      body.append('segments', JSON.stringify(to));
      body.append('file', upload.value);
      await api(`${base.value}/files/uploads`, 'POST', body);
    } else if (action === 'delete') {
      await api(`${base.value}/files`, 'DELETE', {
        segments: selected.value!.segments,
      });
    } else {
      await api(`${base.value}/files/move`, 'POST', {
        from: selected.value!.segments,
        to,
      });
    }
    selected.value = null;
    editable.value = false;
    text.value = savedText.value = '';
    await refreshFiles();
  }, 'Workspace updated.');
}
function chooseUpload(event: Event) {
  upload.value = (event.target as HTMLInputElement).files?.[0] ?? null;
  if (upload.value) destination.value = upload.value.name;
}
</script>
<template>
  <div
    class="flex min-w-0 flex-col items-start justify-between workspace:flex-row workspace:gap-6"
  >
    <div>
      <h1>
        {{ creating ? 'New template' : savedName || 'Template workspace' }}
      </h1>
      <p>Manage your template files and the values document creators enter.</p>
    </div>
    <RouterLink class="link" to="/templates">All templates</RouterLink>
  </div>
  <p v-if="error" role="alert">{{ error }}</p>
  <p v-if="status" role="status">{{ status }}</p>
  <p v-if="loading" role="status">Loading workspace…</p>
  <button class="btn" v-if="!creating && !loading && !loaded" @click="load">
    Retry
  </button>
  <template v-if="creating || loaded">
    <form
      aria-label="Template settings"
      class="my-6 flex w-full min-w-0 flex-col items-start gap-3 [&>label]:w-full [&>label]:max-w-[480px] [&_input]:mb-0"
      @submit.prevent="saveSettings"
      novalidate
    >
      <label
        >Template name<input
          class="input mb-5 min-h-[46px] w-full min-w-0"
          v-model="name"
          aria-label="Template name"
          maxlength="200"
          :disabled="busy"
      /></label>
      <ShapeEditor v-if="creating" v-model="manifest" :disabled="busy" />
      <button class="btn btn-primary" :disabled="busy">
        {{ creating ? 'Create template' : 'Save name' }}
      </button>
    </form>
    <template v-if="!creating">
      <div
        class="my-6 flex flex-wrap gap-2 border-b border-outline pb-3"
        aria-label="Workspace sections"
      >
        <button
          class="btn"
          :class="tab === 'files' ? 'btn-primary' : 'btn-ghost'"
          :aria-pressed="tab === 'files'"
          @click="tab = 'files'"
        >
          Files
        </button>
        <button
          class="btn"
          :class="tab === 'shape' ? 'btn-primary' : 'btn-ghost'"
          :aria-pressed="tab === 'shape'"
          @click="tab = 'shape'"
        >
          Data shape
        </button>
      </div>
      <section v-show="tab === 'shape'" aria-label="Data shape settings">
        <ShapeEditor v-model="manifest" :disabled="busy" />
        <button class="btn btn-primary" :disabled="busy" @click="saveShape">
          Save shape
        </button>
      </section>
      <section v-show="tab === 'files'" aria-label="File workspace">
        <p class="max-w-[900px] text-[13px]">
          Limits: 20 MiB per upload, 100 MiB per workspace, 1 MiB editable text.
          Paths: 128 characters per name, 8 levels, 512 characters total.
          template.tex is the protected entry file.
        </p>
        <div
          class="my-6 flex flex-wrap gap-2 border-b border-outline pb-3 workspace:hidden"
        >
          <button
            class="btn"
            :class="mobilePane === 'files' ? 'btn-primary' : 'btn-ghost'"
            :aria-pressed="mobilePane === 'files'"
            @click="mobilePane = 'files'"
          >
            Browse files
          </button>
          <button
            class="btn"
            :class="mobilePane === 'editor' ? 'btn-primary' : 'btn-ghost'"
            :aria-pressed="mobilePane === 'editor'"
            @click="mobilePane = 'editor'"
          >
            Text editor
          </button>
        </div>
        <div
          class="workspace-panes grid min-w-0 grid-cols-1 overflow-hidden rounded-box border border-outline workspace:grid-cols-[minmax(240px,1fr)_minmax(0,2fr)]"
          :data-pane="mobilePane"
        >
          <aside
            :class="{ 'max-workspace:hidden': mobilePane !== 'files' }"
            class="workspace-browser min-w-0 bg-base-200 p-4 workspace:border-r workspace:border-outline workspace:p-6 [&>label]:mt-6 [&>label]:block"
          >
            <h2>Files</h2>
            <FileTree
              :files="files"
              :selected="selected?.segments.join('/') ?? ''"
              :busy="busy"
              @select="select"
            />
            <label
              >Destination path<input
                class="input mb-5 min-h-[46px] w-full min-w-0"
                v-model="destination"
                aria-label="Destination path"
                :disabled="busy"
                placeholder="parts/header.tex"
            /></label>
            <p class="-mt-3 text-[13px]">
              Use a full relative path, or just a new name for Rename. Parent
              folders must exist.
            </p>
            <div class="actions flex flex-wrap items-start gap-2">
              <button class="btn" :disabled="busy" @click="fileAction('file')">
                Create file
              </button>
              <button
                class="btn"
                :disabled="busy"
                @click="fileAction('directory')"
              >
                Create folder
              </button>
              <button
                class="btn"
                aria-label="Rename selected"
                :disabled="busy || !selected || protectedFile"
                @click="fileAction('rename')"
              >
                Rename
              </button>
              <button
                class="btn"
                aria-label="Move selected"
                :disabled="busy || !selected || protectedFile"
                @click="fileAction('move')"
              >
                Move
              </button>
              <button
                class="btn"
                aria-label="Delete selected"
                :disabled="busy || !selected || protectedFile"
                @click="fileAction('delete')"
              >
                Delete
              </button>
            </div>
            <label class="mt-6 block"
              >Upload file<input
                class="file-input mb-5 w-full min-w-0"
                type="file"
                :disabled="busy"
                @change="chooseUpload"
            /></label>
            <button
              class="btn"
              :disabled="busy || !upload"
              @click="fileAction('upload')"
            >
              Upload
            </button>
          </aside>
          <div
            :class="{ 'max-workspace:hidden': mobilePane !== 'editor' }"
            class="workspace-editor min-w-0 p-4 workspace:p-6"
          >
            <h2>{{ selected?.segments.join('/') || 'Text editor' }}</h2>
            <a class="link" v-if="download" :href="download" download
              >Download file</a
            >
            <TextEditor
              v-if="editable"
              v-model="text"
              :busy="busy"
              :dirty="fileDirty"
              @save="saveFile"
            />
            <p v-else-if="selected?.kind === 'file'">
              This file could not be opened as editable text. You can download
              it or select another file.
            </p>
            <p v-else>
              Select a UTF-8 text file to edit. Manage binary files through
              upload and download.
            </p>
          </div>
        </div>
      </section>
    </template>
  </template>
</template>
