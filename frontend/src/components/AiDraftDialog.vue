<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import type { AiDraftRequest, AiDraftResponse } from "../api/types";

const props = defineProps<{
  templateName: string;
  variables: string[];
  revision: number;
  source: string;
  pending: boolean;
  generate: (form: AiDraftRequest) => Promise<AiDraftResponse | undefined>;
}>();
const emit = defineEmits<{
  close: [];
  apply: [tex: string, revision: number];
}>();
const dialog = ref<HTMLDialogElement>();
const descriptionInput = ref<HTMLTextAreaElement>();
const review = ref<HTMLTextAreaElement>();
const mode = ref<"generate" | "modify">("generate");
const descriptions = reactive({ generate: "", modify: "" });
const settings = reactive({
  pageSize: "A4" as "A4" | "Letter",
  orientation: "portrait" as "portrait" | "landscape",
});
const result = ref<{ tex: string; revision: number }>();
const error = ref("");
const stale = computed(
  () => result.value !== undefined && result.value.revision !== props.revision,
);

onMounted(() => dialog.value?.showModal());
watch(mode, () => {
  error.value = "";
});
watch(
  result,
  (draft) => {
    if (dialog.value?.open)
      (draft ? review.value : descriptionInput.value)?.focus();
  },
  { flush: "post" },
);

async function generate() {
  const description = descriptions[mode.value].trim();
  if (props.pending || !description || description.length > 4000) return;
  if (mode.value === "modify" && !props.source.trim()) return;

  const request =
    mode.value === "modify"
      ? { source: props.source, description }
      : { ...settings, description };

  error.value = "";
  // Match the byte limit of the API's JSON parser, including JSON escaping.
  if (
    mode.value === "modify" &&
    new TextEncoder().encode(JSON.stringify(request)).byteLength > 1024 * 1024
  ) {
    error.value =
      "This Modify request exceeds the 1 MiB limit. Shorten the editor contents or your change description.";
    return;
  }

  const revision = props.revision;
  try {
    const draft = await props.generate(request);
    if (draft) result.value = { ...draft, revision };
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : "AI drafting is unavailable.";
  }
}

function close() {
  dialog.value?.close();
}

function apply() {
  if (!result.value || stale.value) return;
  emit("apply", result.value.tex, result.value.revision);
  close();
}
</script>

<template>
  <dialog
    ref="dialog"
    class="modal"
    aria-labelledby="ai-draft-title"
    @cancel.prevent="close"
    @close="emit('close')"
  >
    <div class="modal-box max-h-[85dvh] w-11/12 max-w-2xl">
      <h2 id="ai-draft-title" class="mb-3 text-lg font-bold">
        Generate with AI
      </h2>

      <template v-if="result">
        <p v-if="stale" role="alert" class="alert alert-warning mb-3">
          The editor changed after generation started. Generate a new draft to
          apply it.
        </p>
        <p v-else class="mb-3 text-sm">
          Applying the draft replaces the editor contents as an unsaved edit.
        </p>
        <label class="mb-1 block text-sm font-semibold" for="ai-draft-tex">
          Generated TeX
        </label>
        <textarea
          id="ai-draft-tex"
          ref="review"
          class="textarea h-[min(40dvh,24rem)] w-full resize-y font-mono text-sm"
          :value="result.tex"
          readonly
        ></textarea>
        <div class="modal-action flex-wrap">
          <button type="button" class="btn" @click="close">Cancel</button>
          <button type="button" class="btn" @click="result = undefined">
            Back
          </button>
          <button
            type="button"
            class="btn btn-primary"
            :disabled="stale"
            @click="apply"
          >
            Apply draft
          </button>
        </div>
      </template>

      <form v-else class="space-y-4" @submit.prevent="generate">
        <div class="tabs tabs-border" role="radiogroup" aria-label="Draft mode">
          <input
            v-model="mode"
            type="radio"
            name="ai-draft-mode"
            class="tab"
            value="generate"
            aria-label="Generate"
            :disabled="pending"
          />
          <input
            v-model="mode"
            type="radio"
            name="ai-draft-mode"
            class="tab"
            value="modify"
            aria-label="Modify"
            :disabled="pending"
          />
        </div>
        <div
          v-if="mode === 'generate'"
          class="grid grid-cols-1 gap-3 sm:grid-cols-2"
        >
          <label class="form-control">
            <span class="mb-1 block text-sm font-semibold">Page size</span>
            <select
              v-model="settings.pageSize"
              name="pageSize"
              class="select w-full"
              :disabled="pending"
            >
              <option>A4</option>
              <option>Letter</option>
            </select>
          </label>
          <label class="form-control">
            <span class="mb-1 block text-sm font-semibold">Orientation</span>
            <select
              v-model="settings.orientation"
              name="orientation"
              class="select w-full"
              :disabled="pending"
            >
              <option value="portrait">Portrait</option>
              <option value="landscape">Landscape</option>
            </select>
          </label>
        </div>
        <label class="form-control">
          <span class="mb-1 block text-sm font-semibold">{{
            mode === "modify" ? "Describe changes" : "Describe your template"
          }}</span>
          <textarea
            ref="descriptionInput"
            v-model="descriptions[mode]"
            name="description"
            class="textarea min-h-24 w-full resize-y"
            rows="4"
            maxlength="4000"
            required
            :disabled="pending"
          ></textarea>
        </label>
        <p v-if="mode === 'modify'" class="text-sm">
          {{
            source.trim()
              ? "Modify sends your current editor contents, including unsaved edits, to OpenAI."
              : "Add TeX to the editor before requesting changes."
          }}
        </p>
        <dl class="space-y-1 break-words rounded-field bg-base-200 p-3 text-sm">
          <div>
            <dt class="inline font-semibold">Saved template</dt>
            <dd class="ml-2 inline">{{ templateName }}</dd>
          </div>
          <div>
            <dt class="inline font-semibold">Saved parameters</dt>
            <dd class="ml-2 inline">{{ variables.join(", ") || "None" }}</dd>
          </div>
        </dl>
        <p v-if="error" role="alert" class="alert alert-error">{{ error }}</p>
        <p v-if="pending" role="status" class="text-sm">Generating draft…</p>
        <div class="modal-action flex-wrap">
          <button type="button" class="btn" @click="close">Cancel</button>
          <button
            type="submit"
            class="btn btn-primary"
            :disabled="
              pending ||
              !descriptions[mode].trim() ||
              (mode === 'modify' && !source.trim())
            "
          >
            {{ mode === "modify" ? "Modify draft" : "Generate draft" }}
          </button>
        </div>
      </form>
    </div>
  </dialog>
</template>
