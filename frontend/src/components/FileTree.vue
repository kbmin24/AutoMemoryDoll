<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import type { TreeEntry } from "../api/types";
import InlineNameEditor from "./InlineNameEditor.vue";

const props = defineProps<{
  files: TreeEntry[];
  selected: string;
  busy: boolean;
  downloadBase?: string;
  draft?: {
    kind: "file" | "directory";
    parent: string[];
    entry?: TreeEntry;
  } | null;
}>();
const emit = defineEmits<{
  select: [entry: TreeEntry];
  create: [name: string];
  cancel: [];
  action: [action: "rename" | "delete", entry: TreeEntry];
  move: [entry: TreeEntry, parent: string[]];
}>();
const dragSource = ref<TreeEntry | null>(null);
const cutEntry = ref<TreeEntry | null>(null);
const movePick = ref<TreeEntry | null>(null);
const dropTarget = ref<string | null>(null);
function canDrop(target: TreeEntry, source = dragSource.value) {
  if (
    props.busy ||
    !source ||
    protectedEntry(source) ||
    target.kind !== "directory"
  )
    return false;
  if (key(source) === [...target.segments, source.name].join("/")) return false;
  return (
    source.kind !== "directory" ||
    !source.segments.every(
      (segment, index) => target.segments[index] === segment,
    )
  );
}
function startDrag(event: DragEvent, entry: TreeEntry) {
  if (
    props.busy ||
    protectedEntry(entry) ||
    props.draft ||
    !entry.segments.length
  ) {
    event.preventDefault();
    return;
  }
  menuEntry.value = null;
  dragSource.value = entry;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", key(entry));
  }
}
function endDrag() {
  dragSource.value = null;
  dropTarget.value = null;
}
function dragOver(event: DragEvent, target: TreeEntry) {
  event.preventDefault();
  if (!canDrop(target)) {
    if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
    return;
  }
  dropTarget.value = key(target);
  expanded.value.add(key(target));
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
}
function drop(event: DragEvent, target: TreeEntry) {
  event.preventDefault();
  const source = dragSource.value;
  const allowed = canDrop(target);
  endDrag();
  if (allowed && source) emit("move", source, [...target.segments]);
}
function downloadUrl(entry: TreeEntry) {
  const query = new URLSearchParams();
  entry.segments.forEach((segment) => query.append("segments", segment));
  return `${props.downloadBase}?${query}`;
}
const root: TreeEntry = { name: "Workspace", kind: "directory", segments: [] };
const expanded = ref(new Set([""]));
const focused = ref("");
const tree = ref<HTMLElement>();
const editorVersion = ref(0);
const menuEntry = ref<TreeEntry | null>(null);
const menu = ref<HTMLElement>();
const menuStyle = ref({ top: "0px", left: "0px" });
function protectedEntry(entry: TreeEntry) {
  return key(entry) === "template.tex";
}
function openMenu(event: MouseEvent, entry: TreeEntry) {
  if (props.busy) return;
  if (menuEntry.value && key(menuEntry.value) === key(entry)) {
    menuEntry.value = null;
    return;
  }
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  menuStyle.value = {
    top: `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - (entry.kind === "file" ? 198 : 152)))}px`,
    left: `${Math.max(8, Math.min(rect.right - 160, window.innerWidth - 168))}px`,
  };
  menuEntry.value = entry;
  void nextTick(() =>
    menu.value
      ?.querySelector<HTMLElement>("button:not(:disabled), a[href]")
      ?.focus(),
  );
}
function dismissMenu(event: Event) {
  const target = event.target as HTMLElement;
  if (!menu.value?.contains(target) && !target.closest("[data-tree-actions]"))
    menuEntry.value = null;
}
function dismissOnScroll() {
  menuEntry.value = null;
}
onMounted(() => {
  document.addEventListener("pointerdown", dismissMenu);
  document.addEventListener("scroll", dismissOnScroll, true);
  window.addEventListener("resize", dismissOnScroll);
});
onUnmounted(() => {
  document.removeEventListener("pointerdown", dismissMenu);
  document.removeEventListener("scroll", dismissOnScroll, true);
  window.removeEventListener("resize", dismissOnScroll);
});
function runAction(action: "rename" | "move" | "delete") {
  const entry = menuEntry.value;
  menuEntry.value = null;
  if (entry && !props.busy && !protectedEntry(entry)) {
    if (action === "move") movePick.value = entry;
    else emit("action", action, entry);
  }
  if (entry)
    void nextTick(() => {
      if (!props.draft && document.activeElement === document.body)
        void focusRow(key(entry));
    });
}
function closeMenu() {
  const entry = menuEntry.value;
  menuEntry.value = null;
  if (entry) void focusRow(key(entry));
}
const key = (entry: TreeEntry) => entry.segments.join("/");
const rows = computed(() => {
  const children = new Map<string, TreeEntry[]>();
  for (const entry of props.files) {
    const parent = entry.segments.slice(0, -1).join("/");
    const siblings = children.get(parent) ?? [];
    siblings.push(entry);
    children.set(parent, siblings);
  }
  const result: TreeEntry[] = [];
  function visit(entry: TreeEntry) {
    result.push(entry);
    if (!expanded.value.has(key(entry))) return;
    const siblings = children.get(key(entry)) ?? [];
    siblings.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const child of siblings) visit(child);
  }
  visit(root);
  return result;
});
const siblingPositions = computed(() => {
  const groups = new Map<string | null, TreeEntry[]>();
  for (const entry of rows.value) {
    const parent = entry.segments.length
      ? entry.segments.slice(0, -1).join("/")
      : null;
    const siblings = groups.get(parent) ?? [];
    siblings.push(entry);
    groups.set(parent, siblings);
  }
  const positions = new Map<string, { position: number; size: number }>();
  for (const [parent, siblings] of groups) {
    const offset =
      props.draft &&
      !props.draft.entry &&
      parent === props.draft.parent.join("/")
        ? 1
        : 0;
    siblings.forEach((entry, index) => {
      positions.set(key(entry), {
        position: index + 1 + offset,
        size: siblings.length + offset,
      });
    });
  }
  return positions;
});
const draftSiblingCount = computed(() =>
  props.draft
    ? props.files.filter(
        (entry) =>
          entry.segments.slice(0, -1).join("/") ===
          props.draft!.parent.join("/"),
      ).length + 1
    : 0,
);
function reveal(segments: string[]) {
  for (let length = 0; length <= segments.length; length++) {
    expanded.value.add(segments.slice(0, length).join("/"));
  }
}
watch(
  () => props.selected,
  (value) => {
    reveal(value ? value.split("/").slice(0, -1) : []);
    focused.value = value;
  },
  { immediate: true },
);
watch(
  () => props.draft,
  async (draft, previous) => {
    editorVersion.value++;
    menuEntry.value = null;
    if (!draft) {
      if (previous) {
        await nextTick();
        const previousPath = previous.entry
          ? key(previous.entry)
          : props.selected;
        const target = props.files.some((entry) => key(entry) === previousPath)
          ? previousPath
          : props.selected;
        await focusRow(target);
      }
      return;
    }
    reveal(draft.parent);
  },
  { immediate: true },
);
async function focusRow(value: string) {
  focused.value = value;
  await nextTick();
  const row = Array.from(
    tree.value?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [],
  ).find((item) => item.dataset.path === value);
  if (value === "") tree.value?.focus();
  else row?.focus();
}
function toggle(entry: TreeEntry) {
  if (props.busy || !entry.segments.length) return;
  const value = key(entry);
  if (expanded.value.has(value)) {
    expanded.value.delete(value);
    if (
      focused.value.startsWith(value ? `${value}/` : "") &&
      focused.value !== value
    ) {
      void focusRow(value);
    }
  } else expanded.value.add(value);
}
function choose(entry: TreeEntry) {
  if (props.busy) return;
  focused.value = key(entry);
  emit("select", entry);
}
function activate(entry: TreeEntry) {
  if (props.busy) return;
  if (movePick.value && canDrop(entry, movePick.value)) {
    const source = movePick.value;
    movePick.value = null;
    emit("move", source, [...entry.segments]);
    return;
  }
  void focusRow(key(entry));
  if (props.draft?.entry && key(props.draft.entry) === key(entry)) return;
  choose(entry);
  if (entry.kind === "directory") toggle(entry);
}
function navigate(event: KeyboardEvent, entry: TreeEntry) {
  if (props.busy) return;
  if (event.ctrlKey || event.metaKey) {
    if (
      event.key.toLowerCase() === "x" &&
      entry.segments.length &&
      !protectedEntry(entry)
    ) {
      event.preventDefault();
      cutEntry.value = entry;
    } else if (
      event.key.toLowerCase() === "v" &&
      canDrop(entry, cutEntry.value)
    ) {
      event.preventDefault();
      const source = cutEntry.value!;
      cutEntry.value = null;
      emit("move", source, [...entry.segments]);
    }
    return;
  }
  const index = rows.value.findIndex((row) => key(row) === key(entry));
  let target: TreeEntry | undefined;
  switch (event.key) {
    case "Escape":
      movePick.value = null;
      cutEntry.value = null;
      break;
    case "ArrowDown":
      target = rows.value[index + 1];
      break;
    case "ArrowUp":
      target = rows.value[index - 1];
      break;
    case "Home":
      target = rows.value[0];
      break;
    case "End":
      target = rows.value.at(-1);
      break;
    case "ArrowRight":
      if (entry.kind === "directory") {
        if (!expanded.value.has(key(entry))) toggle(entry);
        else if (
          rows.value[index + 1]?.segments.length ===
          entry.segments.length + 1
        )
          target = rows.value[index + 1];
      }
      break;
    case "ArrowLeft":
      if (entry.kind === "directory" && expanded.value.has(key(entry)))
        toggle(entry);
      else
        target = rows.value.find(
          (row) => key(row) === entry.segments.slice(0, -1).join("/"),
        );
      break;
    case "Enter":
    case " ":
      activate(entry);
      break;
    default:
      return;
  }
  event.preventDefault();
  if (target) void focusRow(key(target));
}
defineExpose({ focusRow });
function cancel() {
  emit("cancel");
  void focusRow(props.selected);
}
</script>
<template>
  <nav
    aria-label="Workspace files"
    class="file-tree mt-3 min-h-0 flex flex-1 flex-col overflow-auto"
  >
    <p v-if="movePick" role="status" class="mb-2 text-sm">
      Choose a destination folder for {{ movePick.name }}.
      <button
        type="button"
        class="btn btn-ghost btn-sm"
        :disabled="busy"
        @click="movePick = null"
      >
        Cancel move
      </button>
    </p>
    <div
      ref="tree"
      role="tree"
      class="min-h-full flex-1"
      :tabindex="focused === '' ? 0 : -1"
      @click.self="activate(root)"
      @focus.self="focused = ''"
      @keydown.self="navigate($event, root)"
      @dragover.self="dragOver($event, root)"
      @dragleave.self="dropTarget = null"
      @drop.self="drop($event, root)"
      :class="{ 'bg-base-300 outline-2 outline-primary': dropTarget === '' }"
      aria-label="Template workspace"
      :aria-busy="busy"
      aria-description="Drag items onto a folder to move them. Keyboard: Control or Command X to cut, then Control or Command V on a folder to move."
    >
      <template v-for="entry in rows" :key="key(entry)">
        <div
          v-if="entry.segments.length"
          role="treeitem"
          :aria-label="entry.name"
          :aria-level="entry.segments.length"
          :aria-posinset="siblingPositions.get(key(entry))?.position"
          :aria-setsize="siblingPositions.get(key(entry))?.size"
          :aria-selected="selected === key(entry)"
          :aria-expanded="
            entry.kind === 'directory' ? expanded.has(key(entry)) : undefined
          "
          :aria-disabled="busy"
          :data-path="key(entry)"
          :draggable="
            !!entry.segments.length && !busy && !protectedEntry(entry) && !draft
          "
          :class="{
            'bg-base-300 outline-2 outline-primary': dropTarget === key(entry),
          }"
          @dragstart.stop="startDrag($event, entry)"
          @dragend="endDrag"
          @dragover.stop="dragOver($event, entry)"
          @dragleave.self="dropTarget = null"
          @drop.stop="drop($event, entry)"
          :tabindex="focused === key(entry) ? 0 : -1"
          :title="key(entry) || 'Workspace root'"
          class="tree-row relative flex min-h-11 w-full items-center gap-2 rounded-sm pr-2 text-left text-sm hover:bg-base-300 focus-visible:outline-2 focus-visible:outline-primary aria-selected:bg-base-300 aria-selected:font-semibold workspace:min-h-8"
          :style="{ paddingLeft: `${(entry.segments.length - 1) * 16 + 4}px` }"
          @focus="focused = key(entry)"
          @click="activate(entry)"
          @keydown.self="navigate($event, entry)"
        >
          <template v-if="!draft?.entry || key(draft.entry) !== key(entry)">
            <span
              v-if="entry.kind === 'directory'"
              :aria-label="`${expanded.has(key(entry)) ? 'Collapse' : 'Expand'} ${entry.name}`"
              class="flex h-6 w-4 shrink-0 items-center justify-center"
              @click.stop="toggle(entry)"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                class="h-3 w-3"
                :class="{ 'rotate-90': expanded.has(key(entry)) }"
              >
                <path
                  d="m6 3 5 5-5 5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                />
              </svg>
            </span>
            <span v-else class="w-4 shrink-0" />
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              class="h-4 w-4 shrink-0"
              fill="none"
              stroke="currentColor"
              stroke-width="1.3"
            >
              <path
                v-if="entry.kind === 'directory'"
                :d="
                  expanded.has(key(entry))
                    ? 'M2 7V4h6l2 2h7v2M2 8h16l-3 8H4Z'
                    : 'M2 4h6l2 2h8v10H2Z'
                "
              />
              <path v-else d="M5 2h6l4 4v12H5ZM11 2v5h4" />
            </svg>
          </template>
          <InlineNameEditor
            v-if="draft?.entry && key(draft.entry) === key(entry)"
            :key="editorVersion"
            :initial-name="entry.name"
            :label="`Rename ${entry.name}`"
            :busy="busy"
            @click.stop
            @submit="emit('create', $event)"
            @cancel="cancel"
          />
          <template v-else>
            <span class="min-w-0 flex-1 truncate">{{ entry.name }}</span>
            <button
              v-if="entry.segments.length"
              type="button"
              data-tree-actions
              class="tree-actions btn btn-ghost btn-square size-11 min-h-0 shrink-0 workspace:size-8"
              :aria-label="`Actions for ${entry.name}`"
              :aria-expanded="
                menuEntry && key(menuEntry) === key(entry) ? true : false
              "
              :tabindex="focused === key(entry) ? 0 : -1"
              :disabled="busy"
              @click.stop="openMenu($event, entry)"
              @keydown.esc.stop.prevent="closeMenu"
            >
              ⋯
            </button>
          </template>
        </div>
        <div
          v-if="draft && !draft.entry && key(entry) === draft.parent.join('/')"
          role="treeitem"
          :aria-label="draft.kind === 'file' ? 'New file' : 'New folder'"
          :aria-level="draft.parent.length + 1"
          :aria-posinset="1"
          :aria-setsize="draftSiblingCount"
          class="flex min-h-11 items-center workspace:min-h-8"
          :style="{ paddingLeft: `${draft.parent.length * 16 + 4}px` }"
        >
          <InlineNameEditor
            :key="editorVersion"
            initial-name=""
            :label="draft.kind === 'file' ? 'New file name' : 'New folder name'"
            :busy="busy"
            @submit="emit('create', $event)"
            @cancel="cancel"
          />
        </div>
      </template>
    </div>
    <Teleport to="body">
      <div
        v-if="menuEntry"
        ref="menu"
        class="fixed z-50 w-40 rounded-box border border-outline bg-base-100 p-1 shadow-md"
        :style="menuStyle"
        :aria-label="`Actions for ${menuEntry.name}`"
        @keydown.esc.stop.prevent="closeMenu"
        @focusout="
          !menu?.contains($event.relatedTarget as Node) && (menuEntry = null)
        "
      >
        <button
          v-for="action in ['rename', 'move', 'delete'] as const"
          :key="action"
          type="button"
          class="btn btn-ghost min-h-11 w-full justify-start"
          :aria-label="`${action[0]!.toUpperCase() + action.slice(1)} item`"
          :disabled="busy || protectedEntry(menuEntry)"
          @click="runAction(action)"
        >
          {{ action[0]!.toUpperCase() + action.slice(1) }}
        </button>
        <a
          v-if="menuEntry.kind === 'file' && downloadBase"
          :href="downloadUrl(menuEntry)"
          download
          class="btn btn-ghost min-h-11 w-full justify-start"
          @click="menuEntry = null"
          >Download file</a
        >
      </div>
    </Teleport>
  </nav>
</template>
<style scoped>
.tree-row {
  cursor: pointer;
}
</style>
