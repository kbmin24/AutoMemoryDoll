<script setup lang="ts">
import { generate } from "random-words";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
  onBeforeRouteLeave,
  onBeforeRouteUpdate,
  useRoute,
  useRouter,
} from "vue-router";
import { api } from "../api/client";
import type {
  AiDraftRequest,
  AiDraftResponse,
  Template,
  TreeEntry,
} from "../api/types";
import AiDraftDialog from "../components/AiDraftDialog.vue";
import FileTree from "../components/FileTree.vue";
import TextEditor from "../components/TextEditor.vue";
import { codeLanguageForFile } from "../editor";
import ImagePreview from "../components/ImagePreview.vue";
import ShapeEditor from "../components/ShapeEditor.vue";

const route = useRoute();
const router = useRouter();
const creating = computed(() => !route.params.id);
const base = computed(
  () => `/api/templates/${encodeURIComponent(String(route.params.id))}`,
);
const name = ref("");
const savedName = ref("");
const initialManifest = (): Template["manifest"] => ({
  version: 1,
  shape: {
    fields: [{ variable: "", label: "", type: "text", optional: false }],
  },
});
const manifest = ref(initialManifest());
const savedManifest = ref(JSON.stringify(manifest.value));
const files = ref<TreeEntry[]>([]);
const selected = ref<TreeEntry | null>(null);
const editorLanguage = computed(() =>
  codeLanguageForFile(selected.value?.segments ?? []),
);
const editorVariables = computed(() => {
  if (editorLanguage.value !== "jinja-latex") return [];
  return (manifest.value.shape?.fields ?? [])
    .filter((field) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(field.variable))
    .map((field) => ({
      label: field.variable,
      type: "variable",
      detail: `${field.label} · ${
        field.type === "list"
          ? `List(of ${field.itemType === "longtext" ? "Long text" : field.itemType.charAt(0).toUpperCase() + field.itemType.slice(1)})`
          : field.type
      }`,
    }));
});
const text = ref("");
const savedText = ref("");
const editable = ref(false);
const previewVersion = ref(0);
const imagePreviewUrl = computed(() => {
  const entry = selected.value;
  if (entry?.kind !== "file" || !/\.(png|jpe?g)$/i.test(entry.name)) return "";
  return `${base.value}/files/preview?${query(entry.segments)}`;
});

const draft = ref<{
  kind: "file" | "directory";
  parent: string[];
  entry?: TreeEntry;
} | null>(null);
const fileTree = ref<InstanceType<typeof FileTree>>();
const textEditor = ref<InstanceType<typeof TextEditor>>();
const syntaxGuideDialog = ref<HTMLDialogElement>();
const templateSnippets = [
  { label: "Insert variable", icon: "fa-code", source: "{{ var }}" },
  {
    label: "Insert for loop",
    icon: "fa-repeat",
    source: "{% for item in items %}\n  {{ item }}\n{% endfor %}",
  },
  {
    label: "Insert if block",
    icon: "fa-code-branch",
    source: "{% if condition %}\n  \n{% endif %}",
  },
];
const createMenuOpen = ref(false);
const createMenu = ref<HTMLElement>();
const uploadInput = ref<HTMLInputElement>();
let uploadParent: string[] | null = null;
let uploadTemplate = "";
let creationText = "";
const creationParent = computed(() => {
  if (!selected.value) return [];
  return selected.value.kind === "directory"
    ? selected.value.segments
    : selected.value.segments.slice(0, -1);
});
const tab = ref("files");
const mobilePane = ref("files");
const busy = ref(false);
const loading = ref(false);
const loaded = ref(false);
const error = ref("");
const status = ref("");
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

const aiEnabled = ref(false);
const aiDraftOpen = ref(false);
const aiDraftPending = ref(false);
const editorRevision = ref(0);
const canDraft = computed(
  () =>
    aiEnabled.value &&
    loaded.value &&
    editable.value &&
    editorLanguage.value === "jinja-latex",
);
const savedDraftVariables = computed(() => {
  const saved = JSON.parse(savedManifest.value) as Template["manifest"];
  return saved.shape?.fields.map(({ variable }) => variable) ?? [];
});
onMounted(async () => {
  try {
    const { enabled } = await api<{ enabled: boolean }>("/api/auth/ai-status");
    aiEnabled.value = enabled === true;
  } catch {
    aiEnabled.value = false;
  }
});
watch(text, () => editorRevision.value++, { flush: "sync" });
watch(
  [base, selected, canDraft, tab],
  () => {
    aiDraftOpen.value = false;
  },
  { flush: "sync" },
);

async function generateAiDraft(form: AiDraftRequest) {
  if (
    !aiDraftOpen.value ||
    aiDraftPending.value ||
    !canDraft.value ||
    busy.value
  )
    return;
  aiDraftPending.value = true;
  try {
    return await api<AiDraftResponse>(`${base.value}/ai/draft`, "POST", form);
  } finally {
    aiDraftPending.value = false;
  }
}

function applyAiDraft(source: string, revision: number) {
  if (
    aiDraftOpen.value &&
    canDraft.value &&
    !busy.value &&
    revision === editorRevision.value
  ) {
    textEditor.value?.replaceDocument(source);
  }
}

function query(segments: string[]) {
  const params = new URLSearchParams();
  segments.forEach((segment) => params.append("segments", segment));
  return params.toString();
}
const discardDialog = ref<HTMLDialogElement>();
const discardMessage = ref("");
let resolveDiscard: ((confirmed: boolean) => void) | undefined;
function confirmDiscard(message: string): Promise<boolean> {
  if (resolveDiscard) return Promise.resolve(false);
  discardMessage.value = message;
  return new Promise((resolve) => {
    resolveDiscard = resolve;
    discardDialog.value!.showModal();
  });
}
function finishDiscard(confirmed = false) {
  const resolve = resolveDiscard;
  resolveDiscard = undefined;
  if (discardDialog.value?.open) discardDialog.value.close();
  resolve?.(confirmed);
}
onUnmounted(() => finishDiscard());
function discard() {
  return !dirty.value || confirmDiscard("Discard unsaved changes?");
}
onBeforeRouteLeave(() => !busy.value && discard());
onBeforeRouteUpdate(() => !busy.value && discard());
function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value || busy.value) {
    event.preventDefault();
    event.returnValue = "";
  }
}
onMounted(() => window.addEventListener("beforeunload", beforeUnload));
onUnmounted(() => window.removeEventListener("beforeunload", beforeUnload));
async function refreshFiles() {
  files.value = (
    await api<{ files: TreeEntry[] }>(`${base.value}/files`)
  ).files;
}
async function load() {
  loaded.value = false;
  selected.value = null;
  editable.value = false;
  text.value = savedText.value = "";
  draft.value = null;
  createMenuOpen.value = false;
  uploadParent = null;
  tab.value = "files";
  mobilePane.value = "files";
  error.value = status.value = "";
  name.value = savedName.value = "";
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
  error.value = status.value = "";
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
    throw new Error("Add at least one field or disable the data shape.");
  for (const field of fields) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field.variable) ||
      seen.has(field.variable)
    ) {
      throw new Error("Field variables must be valid and unique.");
    }
    if (!field.label.trim() || field.label.length > 200)
      throw new Error(
        "Each field needs a display name of up to 200 characters.",
      );
    if (
      field.type === "list" &&
      !["text", "longtext", "number", "boolean"].includes(field.itemType)
    ) {
      throw new Error("Choose a base type for each list.");
    }
    seen.add(field.variable);
  }
}
async function saveSettings() {
  let createdId: string | undefined;
  await perform(async () => {
    if (!name.value.trim() || name.value.length > 200)
      throw new Error("Enter a template name of up to 200 characters.");
    if (creating.value) {
      validateShape();
      const result = await api<{ template: Template }>(
        "/api/templates",
        "POST",
        { name: name.value, manifest: manifest.value },
      );
      createdId = result.template.id;
      savedManifest.value = JSON.stringify(manifest.value);
    } else {
      await api(base.value, "PATCH", { name: name.value });
    }
    savedName.value = name.value;
  }, "Template saved.");
  if (createdId) await router.replace(`/templates/${createdId}/edit`);
}
async function saveShape() {
  await perform(async () => {
    validateShape();
    await api(base.value, "PATCH", { manifest: manifest.value });
    savedManifest.value = JSON.stringify(manifest.value);
  }, "Data shape saved.");
}
async function showEntry(entry: TreeEntry, openText = true) {
  previewVersion.value++;
  selected.value = entry.segments.length ? entry : null;
  editable.value = false;
  text.value = savedText.value = "";
  if (imagePreviewUrl.value) {
    mobilePane.value = "editor";
    return;
  }
  if (entry.kind === "file" && openText) {
    mobilePane.value = "editor";
    // The server validates UTF-8 and size; file extensions do not determine editability.
    const result = await api<{ text: string }>(
      `${base.value}/files/text?${query(entry.segments)}`,
    );
    text.value = savedText.value = result.text;
    editable.value = true;
  }
}
async function select(entry: TreeEntry) {
  if (
    fileDirty.value &&
    !(await confirmDiscard("Discard unsaved file changes?"))
  )
    return;
  await perform(async () => {
    draft.value = null;
    await showEntry(entry);
  }, "");
}
const bracesWarningDialog = ref<HTMLDialogElement>();
const hideBracesWarning = ref(false);
const bracesWarningStorageKey = "automemorydoll.braces-warning-hidden-until";
function warnAboutTripleBraces(source: string) {
  if (!/\{\{\{[\s\S]*?\}\}\}/.test(source)) return;
  try {
    const hiddenUntil = Number(
      window.localStorage.getItem(bracesWarningStorageKey),
    );
    if (Number.isFinite(hiddenUntil) && hiddenUntil > Date.now()) return;
  } catch {
    // Storage restrictions must not prevent saving or showing the warning.
  }
  hideBracesWarning.value = false;
  bracesWarningDialog.value?.showModal();
}
function dismissBracesWarning() {
  if (hideBracesWarning.value) {
    try {
      const hiddenUntil = Date.now() + 30 * 24 * 60 * 60 * 1000;
      window.localStorage.setItem(bracesWarningStorageKey, String(hiddenUntil));
    } catch {
      // The warning remains enabled when browser storage is unavailable.
    }
  }
  bracesWarningDialog.value?.close();
}
async function saveFile() {
  if (!selected.value || !editable.value) return;
  await perform(async () => {
    if (new TextEncoder().encode(text.value).length > 1024 * 1024)
      throw new Error("Editable text is limited to 1 MiB.");
    await api(`${base.value}/files/text`, "PUT", {
      segments: selected.value!.segments,
      text: text.value,
    });
    savedText.value = text.value;
    if (selected.value!.segments.join("/") === "template.tex") {
      warnAboutTripleBraces(savedText.value);
    }
  }, "File saved.");
}
function pathSegments(value: string) {
  const segments = value.split("/");
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
      "Use relative ASCII paths: letters, numbers, spaces, underscores, hyphens and dots; start with a letter or number. Maximum 128 characters per name, 8 levels, 512 characters total.",
    );
  }
  return segments;
}
function closeCreateMenu(event: PointerEvent) {
  if (!createMenu.value?.contains(event.target as Node))
    createMenuOpen.value = false;
}
function dismissCreateMenu() {
  createMenuOpen.value = false;
}
onMounted(() => {
  document.addEventListener("pointerdown", closeCreateMenu);
  document.addEventListener("scroll", dismissCreateMenu, true);
  window.addEventListener("resize", dismissCreateMenu);
});
onUnmounted(() => {
  document.removeEventListener("pointerdown", closeCreateMenu);
  document.removeEventListener("scroll", dismissCreateMenu, true);
  window.removeEventListener("resize", dismissCreateMenu);
});
async function startCreation(kind: "file" | "directory" | "upload") {
  createMenuOpen.value = false;
  if (busy.value) return;
  if (
    fileDirty.value &&
    !(await confirmDiscard("Discard unsaved file changes?"))
  )
    return;
  error.value = status.value = "";
  creationText = text.value;
  draft.value = null;
  if (kind === "upload") {
    uploadParent = [...creationParent.value];
    uploadTemplate = base.value;
    uploadInput.value?.click();
  } else {
    draft.value = { kind, parent: [...creationParent.value] };
  }
}
function newItemSegments(parent: string[], name: string) {
  if (name.includes("/"))
    throw new Error("Enter a single file or folder name.");
  const segments = pathSegments([...parent, name].join("/"));
  if (
    files.value.some((entry) => entry.segments.join("/") === segments.join("/"))
  ) {
    throw new Error("That path already exists");
  }
  return segments;
}
async function createItem(name: string) {
  if (!draft.value) return;
  if (draft.value.entry?.name === name) {
    draft.value = null;
    return;
  }
  if (
    fileDirty.value &&
    text.value !== creationText &&
    !(await confirmDiscard("Discard unsaved file changes?"))
  )
    return;
  const { kind, parent, entry } = draft.value;
  if (entry) {
    await fileAction("rename", entry, name);
    return;
  }
  await perform(async () => {
    const segments = newItemSegments(parent, name);
    if (kind === "file") {
      await api(`${base.value}/files/text`, "PUT", { segments, text: "" });
    } else {
      await api(`${base.value}/files/directories`, "POST", { segments });
    }
    await refreshFiles();
    draft.value = null;
    await showEntry({ name, kind, segments });
  }, "Workspace updated.");
}
async function chooseUpload(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  const parent = uploadParent;
  uploadParent = null;
  input.value = "";
  if (!file || !parent || uploadTemplate !== base.value) return;
  if (
    fileDirty.value &&
    text.value !== creationText &&
    !(await confirmDiscard("Discard unsaved file changes?"))
  )
    return;
  let uploadName = file.name;
  let segments: string[];
  while (true) {
    try {
      segments = newItemSegments(parent, uploadName);
      break;
    } catch (cause) {
      const dot = file.name.lastIndexOf(".");
      const extension = dot >= 0 ? file.name.slice(dot) : "";
      const suggestion =
        generate({ exactly: 3, minLength: 5, maxLength: 15, join: "-" }) +
        extension;
      const replacement = window.prompt(
        `${cause instanceof Error ? cause.message : "Invalid filename"}\nEnter a new filename for ${file.name}:`,
        suggestion,
      );
      if (replacement === null) return;
      uploadName = replacement;
    }
  }
  await perform(async () => {
    if (file.size > 20 * 1024 * 1024)
      throw new Error("Uploads are limited to 20 MiB per file.");
    const body = new FormData();
    body.append("segments", JSON.stringify(segments));
    body.append("file", file, uploadName);
    await api(`${base.value}/files/uploads`, "POST", body);
    await refreshFiles();
    await showEntry({ name: uploadName, kind: "file", segments }, false);
  }, "Workspace updated.");
}
async function startFileAction(action: "rename" | "delete", entry: TreeEntry) {
  if (busy.value || entry.segments.join("/") === "template.tex") return;
  if (
    fileDirty.value &&
    !(await confirmDiscard("Discard unsaved file changes?"))
  )
    return;
  draft.value = null;
  creationText = text.value;
  error.value = status.value = "";
  if (action === "rename") {
    draft.value = {
      kind: entry.kind,
      parent: entry.segments.slice(0, -1),
      entry,
    };
  } else {
    void fileAction("delete", entry);
  }
}
async function moveEntry(entry: TreeEntry, parent: string[]) {
  if (busy.value || entry.segments.join("/") === "template.tex") return;
  if (
    fileDirty.value &&
    !(await confirmDiscard("Discard unsaved file changes?"))
  )
    return;
  await perform(async () => {
    if (
      !files.value.some(
        (item) => item.segments.join("/") === entry.segments.join("/"),
      )
    )
      throw new Error("The item no longer exists.");
    if (
      entry.kind === "directory" &&
      entry.segments.every((segment, index) => parent[index] === segment)
    )
      throw new Error("A folder cannot be moved into itself.");
    if (
      parent.length &&
      !files.value.some(
        (item) =>
          item.kind === "directory" &&
          item.segments.join("/") === parent.join("/"),
      )
    )
      throw new Error("Select an existing destination folder.");
    const to = newItemSegments(parent, entry.name);
    const openText =
      selected.value?.segments.join("/") === entry.segments.join("/") &&
      editable.value;
    await api(`${base.value}/files/move`, "POST", { from: entry.segments, to });
    await refreshFiles();
    draft.value = null;
    await showEntry({ ...entry, segments: to }, openText);
    await fileTree.value?.focusRow(to.join("/"));
  }, "Workspace updated.");
}
async function fileAction(
  action: "rename" | "delete",
  entry: TreeEntry,
  name?: string,
) {
  if (busy.value || entry.segments.join("/") === "template.tex") return;
  if (
    fileDirty.value &&
    text.value !== creationText &&
    !(await confirmDiscard("Discard unsaved file changes?"))
  )
    return;
  if (
    action === "delete" &&
    !window.confirm(`Delete ${entry.segments.join("/")} and its contents?`)
  )
    return;
  const openText =
    selected.value?.segments.join("/") === entry.segments.join("/") &&
    editable.value;
  await perform(async () => {
    if (action === "delete") {
      await api(`${base.value}/files`, "DELETE", { segments: entry.segments });
      selected.value = null;
      editable.value = false;
      text.value = savedText.value = "";
      await refreshFiles();
    } else {
      const to = newItemSegments(entry.segments.slice(0, -1), name ?? "");
      await api(`${base.value}/files/move`, "POST", {
        from: entry.segments,
        to,
      });
      await refreshFiles();
      await showEntry({ ...entry, name: to.at(-1)!, segments: to }, openText);
    }
    draft.value = null;
  }, "Workspace updated.");
  if (action === "delete") {
    const path = files.value.some(
      (item) => item.segments.join("/") === entry.segments.join("/"),
    )
      ? entry.segments.join("/")
      : "";
    await fileTree.value?.focusRow(path);
  }
}
</script>
<template>
  <div
    class="workspace-view flex min-h-0 flex-1 flex-col"
    :class="{ 'overflow-hidden': !creating }"
  >
    <div
      class="flex min-w-0 flex-col items-start justify-between workspace:flex-row workspace:gap-6"
    >
      <div>
        <h1>
          {{ creating ? "New template" : savedName || "Template workspace" }}
        </h1>
        <p v-if="creating">
          Manage your template files and the values document creators enter.
        </p>
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
      <div
        v-if="!creating"
        class="my-3 flex shrink-0 flex-wrap gap-2 border-b border-outline pb-3"
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
        <button
          class="btn"
          :class="tab === 'settings' ? 'btn-primary' : 'btn-ghost'"
          :aria-pressed="tab === 'settings'"
          @click="tab = 'settings'"
        >
          Settings
        </button>
      </div>
      <form
        v-show="creating || tab === 'settings'"
        aria-label="Template settings"
        class="my-6 flex min-h-0 w-full min-w-0 flex-col overflow-auto items-start gap-3 [&>label]:w-full [&>label]:max-w-[480px] [&_input]:mb-0"
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
          {{ creating ? "Create template" : "Save name" }}
        </button>
        <p v-if="!creating" class="max-w-[900px] text-[13px]">
          Limits: 20 MiB per upload, 100 MiB per workspace, 1 MiB editable text.
          Paths: 128 characters per name, 8 levels, 512 characters total.
          template.tex is the protected entry file.
        </p>
      </form>
      <template v-if="!creating">
        <section
          v-show="tab === 'shape'"
          aria-label="Data shape settings"
          class="min-h-0 overflow-auto"
        >
          <ShapeEditor v-model="manifest" :disabled="busy" />
          <button class="btn btn-primary" :disabled="busy" @click="saveShape">
            Save shape
          </button>
        </section>
        <section
          v-show="tab === 'files'"
          aria-label="File workspace"
          class="flex min-h-0 flex-1 flex-col"
        >
          <div
            class="my-3 flex shrink-0 flex-wrap gap-2 border-b border-outline pb-3 workspace:hidden"
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
            class="workspace-panes grid min-h-0 min-w-0 flex-1 grid-cols-1 rounded-box border border-outline workspace:grid-cols-[minmax(240px,1fr)_minmax(0,2fr)]"
            :data-pane="mobilePane"
          >
            <aside
              :class="{ 'max-workspace:hidden': mobilePane !== 'files' }"
              class="workspace-browser rounded-box workspace:rounded-r-none flex min-h-0 min-w-0 flex-col bg-base-200 p-4 workspace:border-r workspace:border-outline workspace:p-4 [&>label]:mt-6 [&>label]:block"
            >
              <div class="flex shrink-0 items-center justify-between gap-3">
                <h2 class="mb-0">Files</h2>
                <div
                  ref="createMenu"
                  class="relative"
                  @keydown.esc.stop="
                    createMenuOpen = false;
                    (
                      createMenu?.querySelector('button') as HTMLButtonElement
                    )?.focus();
                  "
                  @focusout="
                    !createMenu?.contains($event.relatedTarget as Node) &&
                    (createMenuOpen = false)
                  "
                >
                  <button
                    type="button"
                    class="btn btn-sm"
                    :disabled="busy"
                    :aria-expanded="createMenuOpen"
                    aria-controls="workspace-create-menu"
                    @click="createMenuOpen = !createMenuOpen"
                  >
                    Create ▾
                  </button>
                  <ul
                    v-if="createMenuOpen"
                    id="workspace-create-menu"
                    class="menu absolute right-0 z-10 mt-1 w-44 rounded-box border border-outline bg-base-100 p-1 shadow-md"
                  >
                    <li>
                      <button type="button" @click="startCreation('file')">
                        New file
                      </button>
                    </li>
                    <li>
                      <button type="button" @click="startCreation('directory')">
                        New folder
                      </button>
                    </li>
                    <li>
                      <button type="button" @click="startCreation('upload')">
                        Upload file
                      </button>
                    </li>
                  </ul>
                </div>
              </div>
              <input
                ref="uploadInput"
                type="file"
                class="hidden"
                aria-label="Upload file"
                :disabled="busy"
                @change="chooseUpload"
              />
              <FileTree
                ref="fileTree"
                :key="base"
                :files="files"
                :selected="selected?.segments.join('/') ?? ''"
                :busy="busy"
                :draft="draft"
                :download-base="`${base}/files/download`"
                @select="select"
                @create="createItem"
                @action="startFileAction"
                @move="moveEntry"
                @cancel="draft = null"
              />
            </aside>
            <div
              :class="{ 'max-workspace:hidden': mobilePane !== 'editor' }"
              class="workspace-editor rounded-box workspace:rounded-l-none flex min-h-0 min-w-0 flex-col gap-3 overflow-auto p-4 workspace:p-4"
            >
              <div class="flex shrink-0 flex-wrap items-center gap-2">
                <h2 class="mb-0 min-w-0 break-all">
                  {{ selected?.segments.join("/") || "Text editor" }}
                </h2>
                <div
                  v-if="
                    editable && selected?.segments.join('/') === 'template.tex'
                  "
                  class="flex items-center gap-1"
                  role="group"
                  aria-label="Insert template boilerplate"
                >
                  <button
                    v-for="snippet in templateSnippets"
                    :key="snippet.label"
                    type="button"
                    class="btn btn-ghost btn-sm btn-square"
                    :aria-label="snippet.label"
                    :title="snippet.label"
                    :disabled="busy"
                    @click="textEditor?.insertSnippet(snippet.source)"
                  >
                    <i
                      class="fa-solid"
                      :class="snippet.icon"
                      aria-hidden="true"
                    ></i>
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm btn-square"
                    aria-label="Open syntax guide"
                    title="Syntax guide"
                    aria-haspopup="dialog"
                    @click="syntaxGuideDialog?.showModal()"
                  >
                    <i class="fa-solid fa-question" aria-hidden="true"></i>
                  </button>
                </div>
                <button
                  v-if="canDraft"
                  type="button"
                  class="btn btn-ghost btn-square btn-sm"
                  aria-haspopup="dialog"
                  :disabled="busy"
                  aria-label="Generate with AI"
                  title="Generate with AI"
                  @click="aiDraftOpen = true"
                >
                  <i
                    class="fa-solid fa-wand-magic-sparkles"
                    aria-hidden="true"
                  ></i>
                </button>
              </div>
              <ImagePreview
                v-if="imagePreviewUrl && selected"
                :key="previewVersion"
                :src="imagePreviewUrl"
                :name="selected.name"
              />
              <TextEditor
                v-else-if="editable"
                ref="textEditor"
                :key="selected?.segments.join('/')"
                v-model="text"
                :lang="editorLanguage"
                :variables="editorVariables"
                :busy="busy"
                :dirty="fileDirty"
                @save="saveFile"
              />
              <p v-else-if="selected?.kind === 'file'">
                This file could not be opened as editable text. Download it from
                its three-dot menu or select another file.
              </p>
              <p v-else>
                Select a UTF-8 text file to edit or a PNG/JPEG image to preview.
                Manage other binary files through upload and download.
              </p>
            </div>
          </div>
        </section>
      </template>
    </template>
    <AiDraftDialog
      v-if="aiDraftOpen"
      :template-name="savedName"
      :variables="savedDraftVariables"
      :revision="editorRevision"
      :source="text"
      :pending="aiDraftPending"
      :generate="generateAiDraft"
      @apply="applyAiDraft"
      @close="aiDraftOpen = false"
    />
    <dialog
      ref="syntaxGuideDialog"
      class="modal"
      aria-labelledby="syntax-guide-title"
    >
      <div
        class="modal-box flex max-h-[85dvh] w-11/12 max-w-2xl flex-col overflow-hidden"
      >
        <h2 id="syntax-guide-title" class="mb-4 shrink-0 text-lg font-bold">
          Template syntax guide
        </h2>
        <div
          class="min-h-0 space-y-6 overflow-y-auto pr-2 [&_h3]:mb-2 [&_h3]:font-semibold [&_pre]:overflow-x-auto [&_pre]:rounded-box [&_pre]:bg-base-200 [&_pre]:p-3 [&_pre]:text-sm"
          role="region"
          aria-label="Template syntax reference"
          tabindex="0"
          v-pre
        >
          <p>
            The root template.tex combines LaTeX with MiniJinja. Use the
            variable names defined in Data shape. Replace the example names
            below with yours.
          </p>
          <section>
            <h3>Variables</h3>
            <p>
              Double braces insert a value. Text values are escaped for LaTeX
              automatically.
            </p>
            <pre><code>{{ var }}</code></pre>
          </section>
          <section>
            <h3>LaTeX braces around variables</h3>
            <p>
              Separate the LaTeX braces from the variable delimiters with
              spaces. Use { {{ var }} } instead of {{{var}}}.
            </p>
            <pre><code>\title{ {{ title }} }
\section{ {{ heading }} }</code></pre>
          </section>
          <section>
            <h3>For loops and lists</h3>
            <p>
              Repeat a block for every item in a list. The item name refers to
              the current value.
            </p>
            <pre><code>{% for item in items %}
  {{ item }}
{% endfor %}</code></pre>
          </section>
          <section>
            <h3>If, elif, and else</h3>
            <p>
              Choose content based on a boolean or another condition. The elif
              and else branches are optional.
            </p>
            <pre><code>{% if condition %}
  Shown when the condition is true.
{% elif other_condition %}
  Shown when the other condition is true.
{% else %}
  Shown otherwise.
{% endif %}</code></pre>
          </section>
          <section>
            <h3>Comments</h3>
            <p>Template comments are removed before LaTeX compilation.</p>
            <pre><code>{# This comment is not included in the document. #}</code></pre>
          </section>
          <section>
            <h3>Literal template syntax</h3>
            <p>
              Use a raw block when you want to leave template delimiters
              uninterpreted.
            </p>
            <pre><code>{% raw %}
{{ this_is_not_a_variable }}
{% endraw %}</code></pre>
          </section>
          <section>
            <h3>Files uploaded for each document</h3>
            <p>
              Use <code>@resource(alias)</code> to refer to a file the user
              uploads when generating a document. Start the alias with an ASCII
              letter, then use letters, digits, underscores, or hyphens. The
              generation form asks for one file per alias, and the app replaces
              the token with the uploaded file’s path.
            </p>
            <p>For an image, load <code>graphicx</code> in the preamble.</p>
            <pre><code>\usepackage{graphicx}</code></pre>
            <p>Place the image in the document body.</p>
            <pre><code>\includegraphics{@resource(logo)}</code></pre>
          </section>
          <section>
            <h3>Raw LaTeX with |safe</h3>
            <p>
              Use |safe only when a value intentionally contains raw LaTeX. It
              disables the normal LaTeX escaping for that value.
            </p>
            <pre><code>{{ tex_content |safe }}</code></pre>
          </section>
        </div>
        <div class="modal-action shrink-0">
          <button
            type="button"
            class="btn btn-primary"
            autofocus
            @click="syntaxGuideDialog?.close()"
          >
            Close guide
          </button>
        </div>
      </div>
    </dialog>
    <dialog
      ref="bracesWarningDialog"
      class="modal"
      aria-labelledby="braces-warning-title"
      aria-describedby="braces-warning-description"
      @cancel.prevent="dismissBracesWarning"
    >
      <div class="modal-box">
        <h2 id="braces-warning-title" class="text-lg font-bold">
          Check variable braces
        </h2>
        <p id="braces-warning-description" v-pre>
          Your file was saved. It contains {{{...}}}. For variables wrapped in
          LaTeX braces, use { {{...}} } with spaces between the outer braces and
          the variable delimiters.
        </p>
        <label class="mt-4 flex items-center gap-2">
          <input
            v-model="hideBracesWarning"
            type="checkbox"
            class="checkbox"
            aria-label="Hide this message for 30 days"
          />
          Hide this message for 30 days
        </label>
        <div class="modal-action">
          <button
            type="button"
            class="btn btn-primary"
            autofocus
            @click="dismissBracesWarning"
          >
            OK
          </button>
        </div>
      </div>
    </dialog>
    <dialog
      ref="discardDialog"
      class="modal"
      aria-labelledby="discard-title"
      @cancel.prevent="finishDiscard()"
      @close="finishDiscard()"
    >
      <div class="modal-box">
        <h2 id="discard-title" class="text-lg font-bold">
          {{ discardMessage }}
        </h2>
        <p>Your unsaved changes will be lost.</p>
        <div class="modal-action">
          <button type="button" class="btn" autofocus @click="finishDiscard()">
            Cancel
          </button>
          <button
            type="button"
            class="btn btn-primary"
            @click="finishDiscard(true)"
          >
            Discard
          </button>
        </div>
      </div>
    </dialog>
  </div>
</template>
