import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createMemoryHistory } from "vue-router";
import { createAppRouter } from "../src/router";
import App from "../src/App.vue";
import CodeEditArea from "../src/components/CodeEditArea.vue";
import { editorView, setEditorText } from "./helpers/code-editor";
import { redo, undo } from "@codemirror/commands";
import type { TreeEntry } from "../src/api/types";
import { session } from "../src/api/client";

let wrapper: VueWrapper;
let calls: { path: string; init: RequestInit }[];
let shape: unknown;
let failSave = false;
let draftResponse: () => Promise<Response>;
let workspaceFiles: TreeEntry[];
const field = {
  variable: "name",
  label: "Name",
  type: "text",
  optional: false,
};
const template = () => ({
  id: "letter",
  name: "Letter",
  manifest: { version: 1, shape },
});
let aiEnabled: boolean;

beforeEach(() => {
  // jsdom has no layout measurements for CodeMirror's focused selection.
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
  });
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute("open", "");
      },
    },
    close: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.removeAttribute("open");
        this.dispatchEvent(new Event("close"));
      },
    },
  });
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  calls = [];
  workspaceFiles = [
    { name: "template.tex", kind: "file", segments: ["template.tex"] },
    { name: "logo.png", kind: "file", segments: ["logo.png"] },
    { name: "parts", kind: "directory", segments: ["parts"] },
    { name: "header.tex", kind: "file", segments: ["parts", "header.tex"] },
  ];
  shape = { fields: [field] };
  failSave = false;
  draftResponse = async () => Response.json({ tex: "Generated TeX" });
  aiEnabled = true;
  session.user = null;
  vi.stubGlobal(
    "confirm",
    vi.fn(() => false),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit = {}) => {
      calls.push({ path, init });
      if (path.endsWith("/ai/draft")) return draftResponse();
      let data: unknown = {};
      let status = 200;
      if (path === "/api/auth/ai-status") data = { enabled: aiEnabled };
      else if (path === "/api/auth/me")
        data = {
          user: { id: "self", username: "reader", role: "user" },
          csrfToken: "csrf",
        };
      else if (path === "/api/templates" && init.method === "POST")
        data = { template: template() };
      else if (path === "/api/templates") data = { templates: [template()] };
      else if (path === "/api/templates/letter")
        data = { template: template() };
      else if (path.endsWith("/files") && init.method === "GET")
        data = {
          files: workspaceFiles,
        };
      else if (path.includes("/text?")) {
        if (path.includes("logo.png")) {
          status = 400;
          data = { error: "Not an editable text file" };
        } else data = { text: "Hello" };
      } else if (failSave) {
        status = 400;
        data = { error: "Storage limit exceeded" };
      } else {
        if (path.endsWith("/move")) {
          const { from, to } = JSON.parse(String(init.body)) as {
            from: string[];
            to: string[];
          };
          workspaceFiles = workspaceFiles.map((entry) => {
            if (
              !from.every((segment, index) => entry.segments[index] === segment)
            )
              return entry;
            const segments = [...to, ...entry.segments.slice(from.length)];
            return { ...entry, name: segments.at(-1)!, segments };
          });
        }
        if (
          init.method === "PUT" ||
          path.endsWith("/directories") ||
          path.endsWith("/uploads")
        ) {
          const segments =
            init.body instanceof FormData
              ? JSON.parse(String(init.body.get("segments")))
              : JSON.parse(String(init.body)).segments;
          if (
            !workspaceFiles.some(
              (entry) => entry.segments.join("/") === segments.join("/"),
            )
          ) {
            workspaceFiles.push({
              name: segments.at(-1),
              kind: path.endsWith("/directories") ? "directory" : "file",
              segments,
            });
          }
        }
        status =
          path.endsWith("/directories") || path.endsWith("/uploads")
            ? 201
            : 204;
      }
      return new Response(
        status === 204 || status === 201 ? null : JSON.stringify(data),
        {
          status,
        },
      );
    }),
  );
});
afterEach(() => {
  wrapper?.unmount();
  vi.unstubAllGlobals();
});
async function open(path = "/templates/letter/edit") {
  const router = createAppRouter(createMemoryHistory());
  await router.push(path);
  wrapper = mount(App, {
    attachTo: document.body,
    global: { plugins: [router], stubs: { teleport: true } },
  });
  await flushPromises();
  return router;
}
async function click(text: string) {
  const button = wrapper
    .findAll('button, [role="treeitem"]')
    .find(
      (item) => item.text() === text || item.attributes("aria-label") === text,
    );
  expect(button, text).toBeTruthy();
  await button!.trigger("click");
  await flushPromises();
}
function mutation(method: string, suffix: string) {
  return calls.find(
    (call) => call.init.method === method && call.path.endsWith(suffix),
  );
}
it("creates with an enabled shape and requires one valid field", async () => {
  await open("/templates/new");
  expect(
    wrapper.get<HTMLInputElement>('[aria-label="Define data shape"]').element
      .checked,
  ).toBe(true);
  await wrapper.get('[aria-label="Template name"]').setValue("Letter");
  await wrapper.get("form").trigger("submit");
  expect(mutation("POST", "/api/templates")).toBeUndefined();
  await wrapper.get('[aria-label="Variable 1"]').setValue("name");
  await wrapper.get('[aria-label="Display name 1"]').setValue("Name");
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(
    JSON.parse(String(mutation("POST", "/api/templates")!.init.body)),
  ).toEqual({
    name: "Letter",
    manifest: { version: 1, shape: { fields: [field] } },
  });
});
it("creates with shape explicitly off", async () => {
  await open("/templates/new");
  await wrapper.get('[aria-label="Template name"]').setValue("Letter");
  await wrapper.get('[aria-label="Define data shape"]').setValue(false);
  await wrapper.get("form").trigger("submit");
  await flushPromises();
  expect(
    JSON.parse(String(mutation("POST", "/api/templates")!.init.body)).manifest
      .shape,
  ).toBeNull();
});
it("renames a template", async () => {
  await open();
  await click("Settings");
  await wrapper.get('[aria-label="Template name"]').setValue("Renamed");
  await wrapper.get('[aria-label="Template settings"]').trigger("submit");
  await flushPromises();
  expect(JSON.parse(String(mutation("PATCH", "/letter")!.init.body))).toEqual({
    name: "Renamed",
  });
});
it("edits text without alias controls and reports failed saves", async () => {
  await open();
  await click("template.tex");
  expect(wrapper.find('[aria-label="Resource alias"]').exists()).toBe(false);
  expect(wrapper.text()).not.toContain("Insert resource");
  await setEditorText(wrapper, "changed");
  await click("Save file");
  expect(JSON.parse(String(mutation("PUT", "/text")!.init.body)).text).toBe(
    "changed",
  );
  await setEditorText(wrapper, "changed again");
  failSave = true;
  await click("Save file");
  expect(wrapper.text()).toContain("Storage limit exceeded");
  expect(wrapper.text()).toContain("Unsaved changes");
});
it("protects template.tex and offers download rather than editing rejected binary content", async () => {
  await open();
  await click("template.tex");
  await wrapper.get('[aria-label="Actions for template.tex"]').trigger("click");
  expect(
    wrapper.get('[aria-label="Rename item"]').attributes("disabled"),
  ).toBeDefined();
  expect(
    wrapper.get('[aria-label="Move item"]').attributes("disabled"),
  ).toBeDefined();
  expect(wrapper.get("a[download]").attributes("href")).toContain(
    "segments=template.tex",
  );
  expect(
    wrapper.get('[aria-label="Delete item"]').attributes("disabled"),
  ).toBeDefined();
  await click("logo.png");
  expect(wrapper.find('[aria-label="File content"]').exists()).toBe(false);
  expect(wrapper.get(".workspace-panes").attributes("data-pane")).toBe(
    "editor",
  );
  expect(wrapper.find(".workspace-editor a[download]").exists()).toBe(false);
  await wrapper.get('[aria-label="Actions for logo.png"]').trigger("click");
  expect(wrapper.get("a[download]").attributes("href")).toContain(
    "segments=logo.png",
  );
});
it("uses a modal to cancel or confirm discarding file edits and navigation", async () => {
  const router = await open();
  await click("template.tex");
  await setEditorText(wrapper, "unsaved");
  await click("logo.png");
  expect(
    wrapper.get('[aria-labelledby="discard-title"]').attributes("open"),
  ).toBeDefined();
  await click("Cancel");
  expect(editorView(wrapper).state.doc.toString()).toBe("unsaved");
  const navigation = router.push("/templates");
  await flushPromises();
  await click("Cancel");
  await navigation;
  expect(router.currentRoute.value.path).toBe("/templates/letter/edit");
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  await click("logo.png");
  await click("Discard");
  expect(wrapper.findComponent(CodeEditArea).exists()).toBe(false);
  expect(window.confirm).not.toHaveBeenCalled();
});

it("creates files and folders, renames, moves, deletes with confirmation, and uploads multipart", async () => {
  await open();
  await click("Create ▾");
  await click("New file");
  await wrapper.get('[aria-label="New file name"]').setValue("notes.tex");
  await wrapper
    .get('[aria-label="New file name"]')
    .trigger("keydown", { key: "Enter" });
  await flushPromises();
  expect(JSON.parse(String(mutation("PUT", "/text")!.init.body))).toEqual({
    segments: ["notes.tex"],
    text: "",
  });
  expect(editorView(wrapper).state.doc.toString()).toBe("Hello");
  await click("Create ▾");
  await click("New folder");
  await wrapper.get('[aria-label="New folder name"]').setValue("assets");
  await wrapper
    .get('[aria-label="New folder name"]')
    .trigger("keydown", { key: "Enter" });
  await flushPromises();
  expect(wrapper.text()).toContain("Workspace updated.");
  expect(
    JSON.parse(String(mutation("POST", "/directories")!.init.body)),
  ).toEqual({ segments: ["assets"] });
  await click("logo.png");
  await wrapper.get('[aria-label="Actions for logo.png"]').trigger("click");
  await click("Rename");
  await wrapper.get('[aria-label="Rename logo.png"]').setValue("brand.png");
  await wrapper
    .get('[aria-label="Rename logo.png"]')
    .trigger("keydown", { key: "Enter" });
  await flushPromises();
  expect(JSON.parse(String(mutation("POST", "/move")!.init.body))).toEqual({
    from: ["logo.png"],
    to: ["brand.png"],
  });
  await wrapper.get('[aria-label="brand.png"]').trigger("dragstart", {
    dataTransfer: { setData() {}, effectAllowed: "" },
  });
  await wrapper.get('[aria-label="parts"]').trigger("drop");
  await flushPromises();
  expect(calls.filter((c) => c.path.endsWith("/move")).at(-1)!.init.body).toBe(
    JSON.stringify({ from: ["brand.png"], to: ["parts", "brand.png"] }),
  );
  await click("parts");
  vi.mocked(window.confirm).mockReturnValue(true);
  await wrapper.get('[aria-label="Actions for parts"]').trigger("click");
  await click("Delete");
  expect(JSON.parse(String(mutation("DELETE", "/files")!.init.body))).toEqual({
    segments: ["parts"],
  });
  await wrapper.get('[role="tree"]').trigger("click");
  await click("Create ▾");
  await click("Upload file");
  const input = wrapper.get('input[type="file"]');
  Object.defineProperty(input.element, "files", {
    value: [new File(["png"], "new.png")],
  });
  await input.trigger("change");
  await flushPromises();
  expect(wrapper.text()).toContain("Workspace updated.");
  const upload = mutation("POST", "/uploads")!;
  expect(upload.init.body).toBeInstanceOf(FormData);
  expect((upload.init.body as FormData).get("segments")).toBe('["new.png"]');
  expect(upload.init.headers).toEqual({ "X-CSRF-Token": "csrf" });
});
it("validates unique variables and supports type, optional, reorder and remove controls", async () => {
  await open();
  await click("Data shape");
  await click("Add field");
  await wrapper.get('[aria-label="Variable 2"]').setValue("name");
  await wrapper.get('[aria-label="Display name 2"]').setValue("Second");
  await click("Save shape");
  expect(mutation("PATCH", "/letter")).toBeUndefined();
  await wrapper.get('[aria-label="Variable 2"]').setValue("notes");
  await wrapper.get('[aria-label="Type 2"]').setValue("longtext");
  await wrapper.get('[aria-label="Optional 2"]').setValue(true);
  await wrapper.get('[aria-label="Move field 2 up"]').trigger("click");
  await click("Save shape");
  const saved = JSON.parse(String(mutation("PATCH", "/letter")!.init.body))
    .manifest.shape.fields;
  expect(saved[0]).toEqual({
    variable: "notes",
    label: "Second",
    type: "longtext",
    optional: true,
  });
  await wrapper.get('[aria-label="Remove field 2"]').trigger("click");
  expect(wrapper.findAll('[aria-label^="Variable "]')).toHaveLength(1);
});

it("ignores a delayed response for a previously selected template", async () => {
  const router = await open();
  const originalFetch = fetch;
  let resolveOld!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn((path: string, init?: RequestInit) => {
      if (path === "/api/templates/old")
        return new Promise<Response>((resolve) => {
          resolveOld = resolve;
        });
      if (path === "/api/templates/newer")
        return Promise.resolve(
          new Response(
            JSON.stringify({
              template: { ...template(), id: "newer", name: "Newer" },
            }),
          ),
        );
      return originalFetch(path, init);
    }),
  );
  await router.push("/templates/old/edit");
  await flushPromises();
  await router.push("/templates/newer/edit");
  await flushPromises();
  expect(
    wrapper.get<HTMLInputElement>('[aria-label="Template name"]').element.value,
  ).toBe("Newer");
  resolveOld(
    new Response(
      JSON.stringify({ template: { ...template(), id: "old", name: "Old" } }),
    ),
  );
  await flushPromises();
  expect(
    wrapper.get<HTMLInputElement>('[aria-label="Template name"]').element.value,
  ).toBe("Newer");
});
it("shows the download pane when a binary file is selected first on mobile", async () => {
  await open();
  await click("logo.png");
  expect(wrapper.get(".workspace-panes").attributes("data-pane")).toBe(
    "editor",
  );
});

it("creates inside a selected folder and alongside a selected nested file", async () => {
  await open();
  await click("parts");
  await click("Create ▾");
  await click("New file");
  await wrapper.get('[aria-label="New file name"]').setValue("notes.tex");
  await wrapper
    .get('[aria-label="New file name"]')
    .trigger("keydown", { key: "Enter" });
  await flushPromises();
  expect(
    JSON.parse(String(mutation("PUT", "/text")!.init.body)).segments,
  ).toEqual(["parts", "notes.tex"]);
  expect(
    wrapper.get('[aria-label="notes.tex"]').attributes("aria-selected"),
  ).toBe("true");
  await click("Create ▾");
  await click("New folder");
  await wrapper.get('[aria-label="New folder name"]').setValue("assets");
  await wrapper
    .get('[aria-label="New folder name"]')
    .trigger("keydown", { key: "Enter" });
  await flushPromises();
  expect(
    JSON.parse(String(mutation("POST", "/directories")!.init.body)).segments,
  ).toEqual(["parts", "assets"]);
});
it("retains failed inline names, rejects paths and duplicates, and cancels without writing", async () => {
  await open();
  await click("Create ▾");
  await click("New file");
  const input = wrapper.get<HTMLInputElement>('[aria-label="New file name"]');
  for (const name of ["../bad.tex", "parts/new.tex", "template.tex"]) {
    await input.setValue(name);
    await input.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(mutation("PUT", "/text")).toBeUndefined();
  }
  await input.setValue("new.tex");
  failSave = true;
  await input.trigger("keydown", { key: "Enter" });
  await flushPromises();
  expect(wrapper.text()).toContain("Storage limit exceeded");
  expect(input.element.value).toBe("new.tex");
  await input.trigger("keydown", { key: "Escape" });
  expect(wrapper.find('[aria-label="New file name"]').exists()).toBe(false);
});
it("uploads to the captured folder even if selection changes while the picker is open", async () => {
  await open();
  await click("parts");
  await click("Create ▾");
  await click("Upload file");
  await click("logo.png");
  const input = wrapper.get('input[type="file"]');
  Object.defineProperty(input.element, "files", {
    value: [new File(["data"], "asset.png")],
  });
  await input.trigger("change");
  await flushPromises();
  expect(
    (mutation("POST", "/uploads")!.init.body as FormData).get("segments"),
  ).toBe('["parts","asset.png"]');
});
it("keeps unsaved edits when creation is declined", async () => {
  await open();
  await click("template.tex");
  await setEditorText(wrapper, "unsaved");
  await click("Create ▾");
  await click("New file");
  expect(wrapper.find('[aria-label="New file name"]').exists()).toBe(false);
  expect(editorView(wrapper).state.doc.toString()).toBe("unsaved");
});
it("guards edits made after inline creation began", async () => {
  await open();
  await click("template.tex");
  await click("Create ▾");
  await click("New file");
  await setEditorText(wrapper, "changed while naming");
  await wrapper.get('[aria-label="New file name"]').setValue("new.tex");
  await wrapper
    .get('[aria-label="New file name"]')
    .trigger("keydown", { key: "Enter" });
  await flushPromises();
  expect(mutation("PUT", "/text")).toBeUndefined();
  expect(editorView(wrapper).state.doc.toString()).toBe("changed while naming");
});

it("renames an unselected file inline, retains failed names and cancels without changing the editor", async () => {
  await open();
  await click("template.tex");
  await wrapper.get('[aria-label="Actions for logo.png"]').trigger("click");
  await click("Rename");
  expect(document.activeElement?.getAttribute("aria-label")).toBe(
    "Rename logo.png",
  );
  const input = wrapper.get<HTMLInputElement>('[aria-label="Rename logo.png"]');
  expect(input.element.value).toBe("logo.png");
  await input.setValue("brand.png");
  failSave = true;
  await input.trigger("keydown", { key: "Enter" });
  await flushPromises();
  expect(wrapper.text()).toContain("Storage limit exceeded");
  expect(input.element.value).toBe("brand.png");
  await input.trigger("keydown", { key: "Escape" });
  expect(wrapper.find('[aria-label="Rename logo.png"]').exists()).toBe(false);
  expect(editorView(wrapper).state.doc.toString()).toBe("Hello");
  expect(JSON.parse(String(mutation("POST", "/move")!.init.body))).toEqual({
    from: ["logo.png"],
    to: ["brand.png"],
  });
});
it("deletes the menu target rather than the selected editor file", async () => {
  await open();
  await click("template.tex");
  await wrapper.get('[aria-label="Actions for logo.png"]').trigger("click");
  vi.mocked(window.confirm).mockReturnValue(true);
  await click("Delete");
  expect(JSON.parse(String(mutation("DELETE", "/files")!.init.body))).toEqual({
    segments: ["logo.png"],
  });
});

it("accepts an unchanged rename without a request and rejects paths or existing names", async () => {
  await open();
  await wrapper.get('[aria-label="Actions for logo.png"]').trigger("click");
  await click("Rename");
  await wrapper
    .get('[aria-label="Rename logo.png"]')
    .trigger("keydown", { key: "Enter" });
  await flushPromises();
  expect(wrapper.find('[aria-label="Rename logo.png"]').exists()).toBe(false);
  expect(mutation("POST", "/move")).toBeUndefined();
  await wrapper.get('[aria-label="Actions for logo.png"]').trigger("click");
  await click("Rename");
  for (const name of ["parts/logo.png", "template.tex"]) {
    await wrapper.get('[aria-label="Rename logo.png"]').setValue(name);
    await wrapper
      .get('[aria-label="Rename logo.png"]')
      .trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(mutation("POST", "/move")).toBeUndefined();
  }
});
it("renames a folder inline and reveals its renamed descendants", async () => {
  await open();
  await wrapper.get('[aria-label="Actions for parts"]').trigger("click");
  await click("Rename");
  await wrapper.get('[aria-label="Rename parts"]').setValue("sections");
  await wrapper
    .get('[aria-label="Rename parts"]')
    .trigger("keydown", { key: "Enter" });
  await flushPromises();
  expect(
    wrapper.get('[aria-label="sections"]').attributes("aria-selected"),
  ).toBe("true");
  await wrapper.get('[aria-label="Expand sections"]').trigger("click");
  expect(wrapper.get('[aria-label="header.tex"]').attributes("data-path")).toBe(
    "sections/header.tex",
  );
});

it("restores row focus after canceled deletion", async () => {
  await open();
  await wrapper.get('[aria-label="Actions for logo.png"]').trigger("click");
  await click("Delete");
  expect(document.activeElement?.getAttribute("data-path")).toBe("logo.png");
  expect(mutation("DELETE", "/files")).toBeUndefined();
});

it("shows template name only under Settings and removes the move form", async () => {
  await open();
  expect(wrapper.get('[aria-label="Template name"]').isVisible()).toBe(false);
  await click("Settings");
  expect(wrapper.get('[aria-label="Template name"]').isVisible()).toBe(true);
  await click("Files");
  expect(wrapper.get('[aria-label="Template name"]').isVisible()).toBe(false);
  expect(wrapper.find('[aria-label="Destination path"]').exists()).toBe(false);
});
it("moves with drag/drop while retaining dirty guards and reporting failed requests", async () => {
  await open();
  await click("template.tex");
  await setEditorText(wrapper, "unsaved");
  const drag = () =>
    wrapper.get('[aria-label="logo.png"]').trigger("dragstart", {
      dataTransfer: { setData() {}, effectAllowed: "" },
    });
  await drag();
  await wrapper.get('[aria-label="parts"]').trigger("drop");
  await flushPromises();
  expect(mutation("POST", "/move")).toBeUndefined();
  await click("Cancel");
  failSave = true;
  await drag();
  await wrapper.get('[aria-label="parts"]').trigger("drop");
  await flushPromises();
  await click("Discard");
  expect(wrapper.text()).toContain("Storage limit exceeded");
  expect(editorView(wrapper).state.doc.toString()).toBe("unsaved");
});
it("rejects move collisions before sending a request and keeps file-only downloads", async () => {
  await open();
  await click("parts");
  await click("Create ▾");
  await click("Upload file");
  const input = wrapper.get('input[type="file"]');
  Object.defineProperty(input.element, "files", {
    value: [new File(["image"], "logo.png")],
  });
  await input.trigger("change");
  await flushPromises();
  await wrapper.get('[role="tree"]').trigger("keydown", { key: "Home" });
  const rootLogo = wrapper
    .findAll('[role="treeitem"]')
    .find((row) => row.attributes("data-path") === "logo.png")!;
  await rootLogo.trigger("dragstart", {
    dataTransfer: { setData() {}, effectAllowed: "" },
  });
  await wrapper.get('[aria-label="parts"]').trigger("drop");
  await flushPromises();
  expect(wrapper.text()).toContain("That path already exists");
  expect(mutation("POST", "/move")).toBeUndefined();
  await wrapper.get('[aria-label="Actions for parts"]').trigger("click");
  expect(wrapper.find("a[download]").exists()).toBe(false);
});

it("moves from the row menu by choosing a folder without a path box", async () => {
  await open();
  await wrapper.get('[aria-label="Actions for logo.png"]').trigger("click");
  await click("Move");
  expect(wrapper.find('[aria-label="Destination path"]').exists()).toBe(false);
  expect(wrapper.text()).toContain("Choose a destination folder for logo.png");
  await click("parts");
  expect(JSON.parse(String(mutation("POST", "/move")!.init.body))).toEqual({
    from: ["logo.png"],
    to: ["parts", "logo.png"],
  });
});

it.each(["invalid,filename.jpg", "logo.png", "invalid,name"])(
  "prompts for a replacement when uploading %s",
  async (originalName) => {
    const prompt = vi
      .fn()
      .mockReturnValueOnce("still,invalid")
      .mockReturnValueOnce("replacement.png");
    vi.stubGlobal("prompt", prompt);
    await open();
    await click("Create ▾");
    await click("Upload file");
    const input = wrapper.get('input[type="file"]');
    Object.defineProperty(input.element, "files", {
      value: [new File(["image"], originalName)],
    });
    await input.trigger("change");
    await flushPromises();
    const dot = originalName.lastIndexOf(".");
    const extension = dot >= 0 ? originalName.slice(dot) : "";
    expect(prompt).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      expect.stringMatching(
        new RegExp(
          "^[a-z]{5,15}-[a-z]{5,15}-[a-z]{5,15}" +
            extension.replace(".", "\\.") +
            "$",
        ),
      ),
    );
    expect(prompt).toHaveBeenCalledTimes(2);
    const upload = calls.find((call) => call.path.endsWith("/uploads"))!;
    const body = upload.init.body as FormData;
    expect(JSON.parse(String(body.get("segments")))).toEqual([
      "replacement.png",
    ]);
    expect((body.get("file") as File).name).toBe("replacement.png");
  },
);

it("cancels an invalid-name upload without sending it", async () => {
  vi.stubGlobal(
    "prompt",
    vi.fn(() => null),
  );
  await open();
  await click("Create ▾");
  await click("Upload file");
  const input = wrapper.get('input[type="file"]');
  Object.defineProperty(input.element, "files", {
    value: [new File(["image"], "invalid,name.jpg")],
  });
  await input.trigger("change");
  await flushPromises();
  expect(calls.some((call) => call.path.endsWith("/uploads"))).toBe(false);
});

it("previews PNG files without requesting text and falls back after an image error", async () => {
  await open();
  await click("logo.png");
  const image = wrapper.get('img[alt="Preview of logo.png"]');
  expect(image.attributes("src")).toBe(
    "/api/templates/letter/files/preview?segments=logo.png",
  );
  expect(
    calls.some((call) => call.path.includes("/files/text?segments=logo.png")),
  ).toBe(false);
  await image.trigger("error");
  expect(wrapper.text()).toContain("This image could not be previewed");
  expect(wrapper.find('img[alt="Preview of logo.png"]').exists()).toBe(false);
  await click("template.tex");
  expect(wrapper.find('[aria-label="File content"]').exists()).toBe(true);
});

it("previews JPEG filenames case-insensitively and resets failed previews on selection", async () => {
  workspaceFiles.push({
    name: "Photo.JPEG",
    kind: "file",
    segments: ["Photo.JPEG"],
  });
  await open();
  await click("logo.png");
  await wrapper.get('img[alt="Preview of logo.png"]').trigger("error");
  await click("Photo.JPEG");
  expect(
    wrapper.get('img[alt="Preview of Photo.JPEG"]').attributes("src"),
  ).toBe("/api/templates/letter/files/preview?segments=Photo.JPEG");
  expect(wrapper.text()).not.toContain("This image could not be previewed");
  await wrapper.get('img[alt="Preview of Photo.JPEG"]').trigger("load");
  expect(wrapper.text()).not.toContain("Loading image");
  await click("parts");
  expect(wrapper.find(".workspace-editor img").exists()).toBe(false);
});

it("selects the code language from the workspace file and isolates file undo history", async () => {
  workspaceFiles.push(
    { name: "layout.sty", kind: "file", segments: ["layout.sty"] },
    { name: "data.json", kind: "file", segments: ["data.json"] },
    { name: "notes.txt", kind: "file", segments: ["notes.txt"] },
  );
  await open();
  await click("template.tex");
  expect(wrapper.findComponent(CodeEditArea).props("lang")).toBe("jinja-latex");
  await setEditorText(wrapper, "Saved template");
  await click("Save file");
  await click("layout.sty");
  expect(wrapper.findComponent(CodeEditArea).props("lang")).toBe("latex");
  expect(undo(editorView(wrapper))).toBe(false);
  expect(editorView(wrapper).state.doc.toString()).toBe("Hello");
  await click("data.json");
  expect(wrapper.findComponent(CodeEditArea).props("lang")).toBe("javascript");
  await click("notes.txt");
  expect(wrapper.findComponent(CodeEditArea).props("lang")).toBeUndefined();
});

it("passes current shape variables only to the root Jinja editor and updates them after shape edits", async () => {
  await open();
  await click("template.tex");
  expect(wrapper.findComponent(CodeEditArea).props("variables")).toEqual([
    { label: "name", type: "variable", detail: "Name · text" },
  ]);
  await click("Data shape");
  await wrapper.get('[aria-label="Variable 1"]').setValue("bad name");
  await click("Files");
  expect(wrapper.findComponent(CodeEditArea).props("variables")).toEqual([]);
  await click("Data shape");
  await wrapper.get('[aria-label="Variable 1"]').setValue("student_name");
  await wrapper.get('[aria-label="Display name 1"]').setValue("Student name");
  await click("Files");
  expect(wrapper.findComponent(CodeEditArea).props("variables")).toEqual([
    { label: "student_name", type: "variable", detail: "Student name · text" },
  ]);
  expect(editorView(wrapper).state.doc.toString()).toBe("Hello");
  await click("parts");
  await click("header.tex");
  expect(wrapper.findComponent(CodeEditArea).props("variables")).toEqual([]);
  await click("Data shape");
  await wrapper.get('[aria-label="Define data shape"]').setValue(false);
  await click("Files");
  await click("template.tex");
  expect(wrapper.findComponent(CodeEditArea).props("variables")).toEqual([]);
});

it("saves and reloads a list base type and clears it when returning to a scalar", async () => {
  await open();
  await click("Data shape");
  await wrapper.get('[aria-label="Type 1"]').setValue("list");
  const base = wrapper.get('[aria-label="List item type 1"]');
  expect(base.attributes("required")).toBeDefined();
  expect(
    base.findAll("option").map((option) => option.attributes("value")),
  ).toEqual(["", "text", "longtext", "number", "boolean"]);
  await base.setValue("number");
  await click("Save shape");
  const saved = JSON.parse(
    String(mutation("PATCH", "/letter")!.init.body),
  ).manifest;
  expect(saved.shape.fields).toEqual([
    { ...field, type: "list", itemType: "number" },
  ]);
  wrapper.unmount();
  shape = saved.shape;
  await open();
  await click("Data shape");
  expect(
    (
      wrapper.get('[aria-label="List item type 1"]')
        .element as HTMLSelectElement
    ).value,
  ).toBe("number");
  await click("Files");
  await click("template.tex");
  expect(wrapper.findComponent(CodeEditArea).props("variables")).toEqual([
    { label: "name", type: "variable", detail: "Name · List(of Number)" },
  ]);
  await click("Data shape");
  await wrapper.get('[aria-label="Type 1"]').setValue("text");
  expect(wrapper.find('[aria-label="List item type 1"]').exists()).toBe(false);
  calls = [];
  await click("Save shape");
  expect(
    JSON.parse(String(mutation("PATCH", "/letter")!.init.body)).manifest.shape
      .fields,
  ).toEqual([field]);
});

it("does not save a List field before a base type is chosen", async () => {
  await open();
  await click("Data shape");
  await wrapper.get('[aria-label="Type 1"]').setValue("list");
  await click("Save shape");
  expect(mutation("PATCH", "/letter")).toBeUndefined();
});

it("warns after saving triple braces without changing the saved text", async () => {
  await open();
  await click("template.tex");
  const source = "\\title{{{name}}}\n{{{\nother\n}}}";
  await setEditorText(wrapper, source);
  await click("Save file");
  expect(JSON.parse(String(mutation("PUT", "/text")!.init.body)).text).toBe(
    source,
  );
  const dialog = wrapper.get('[aria-labelledby="braces-warning-title"]');
  expect(dialog.attributes("open")).toBeDefined();
  expect(dialog.text()).toContain("{ {{...}} }");
  expect(wrapper.text()).toContain("File saved.");
  await click("OK");
  expect(dialog.attributes("open")).toBeUndefined();
  await setEditorText(wrapper, "{{{another}}}");
  await click("Save file");
  expect(dialog.attributes("open")).toBeDefined();
});

it("hides the braces warning for 30 days and shows it again at expiry", async () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  await open();
  await click("template.tex");
  await setEditorText(wrapper, "{{{name}}}");
  await click("Save file");
  await wrapper
    .get('[aria-label="Hide this message for 30 days"]')
    .setValue(true);
  await click("OK");
  wrapper.unmount();
  await open();
  await click("template.tex");
  await setEditorText(wrapper, "{{{hidden}}}");
  await click("Save file");
  const dialog = wrapper.get('[aria-labelledby="braces-warning-title"]');
  expect(dialog.attributes("open")).toBeUndefined();
  clock.mockReturnValue(now + 30 * 24 * 60 * 60 * 1000);
  await setEditorText(wrapper, "{{{expired}}}");
  await click("Save file");
  expect(dialog.attributes("open")).toBeDefined();
});

it("does not warn for separated braces, support files, or failed saves", async () => {
  await open();
  await click("template.tex");
  await setEditorText(wrapper, "{ {{name}} }");
  await click("Save file");
  const dialog = wrapper.get('[aria-labelledby="braces-warning-title"]');
  expect(dialog.attributes("open")).toBeUndefined();
  await setEditorText(wrapper, "{{{failed}}}");
  failSave = true;
  await click("Save file");
  expect(dialog.attributes("open")).toBeUndefined();
  failSave = false;
  await click("logo.png");
  await click("Discard");
  await click("parts");
  await click("header.tex");
  await setEditorText(wrapper, "{{{support}}}");
  await click("Save file");
  expect(dialog.attributes("open")).toBeUndefined();
});

it("still saves and warns when browser storage is unavailable", async () => {
  vi.stubGlobal("localStorage", {
    getItem() {
      throw new Error("Storage disabled");
    },
    setItem() {
      throw new Error("Storage disabled");
    },
  });
  await open();
  await click("template.tex");
  await setEditorText(wrapper, "{{{\nname\n}}}");
  await click("Save file");
  const dialog = wrapper.get('[aria-labelledby="braces-warning-title"]');
  expect(dialog.attributes("open")).toBeDefined();
  expect(wrapper.text()).toContain("File saved.");
  await wrapper
    .get('[aria-label="Hide this message for 30 days"]')
    .setValue(true);
  await click("OK");
  expect(dialog.attributes("open")).toBeUndefined();
  await setEditorText(wrapper, "{{{again}}}");
  await click("Save file");
  expect(dialog.attributes("open")).toBeDefined();
});

it.each([
  ["Insert variable", "{{ var }}"],
  ["Insert for loop", "{% for item in items %}\n  {{ item }}\n{% endfor %}"],
  ["Insert if block", "{% if condition %}\n  \n{% endif %}"],
])("%s replaces the selection and remains undoable", async (label, snippet) => {
  await open();
  await click("template.tex");
  await setEditorText(wrapper, "before replace after");
  const view = editorView(wrapper);
  view.dispatch({ selection: { anchor: 7, head: 14 } });
  await click(label);
  expect(view.state.doc.toString()).toBe(`before ${snippet} after`);
  expect(view.hasFocus).toBe(true);
  expect(wrapper.text()).toContain("Unsaved changes");
  expect(undo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe("before replace after");
});

it("shows snippet buttons only for the root template.tex", async () => {
  await open();
  expect(wrapper.find('[aria-label="Insert variable"]').exists()).toBe(false);
  await click("template.tex");
  expect(wrapper.find('[aria-label="Insert variable"]').exists()).toBe(true);
  await click("parts");
  await click("header.tex");
  expect(wrapper.find('[aria-label="Insert variable"]').exists()).toBe(false);
});

it("opens and closes the syntax guide without changing the editor", async () => {
  await open();
  expect(wrapper.find('[aria-label="Open syntax guide"]').exists()).toBe(false);
  await click("template.tex");
  await setEditorText(wrapper, "unsaved document");
  await click("Open syntax guide");
  const dialog = wrapper.get('[aria-labelledby="syntax-guide-title"]');
  expect(dialog.classes()).toContain("modal");
  expect(dialog.attributes("open")).toBeDefined();
  expect(
    dialog.get('[aria-label="Template syntax reference"]').classes(),
  ).toContain("overflow-y-auto");
  expect(dialog.text()).toContain("{{ var }}");
  expect(dialog.text()).toContain("{ {{ var }} }");
  expect(dialog.text()).toContain("{% for item in items %}");
  expect(dialog.text()).toContain("{% if condition %}");
  expect(dialog.text()).toContain("|safe");
  expect(dialog.text()).toContain(
    String.raw`\includegraphics{@resource(logo)}`,
  );
  await click("Close guide");
  expect(dialog.attributes("open")).toBeUndefined();
  expect(editorView(wrapper).state.doc.toString()).toBe("unsaved document");
  await click("Save file");
  await click("parts");
  await click("header.tex");
  expect(wrapper.find('[aria-label="Open syntax guide"]').exists()).toBe(false);
});

function aiDialog() {
  return wrapper.get('dialog[aria-labelledby="ai-draft-title"][open]');
}

async function startAiDraft() {
  await click("template.tex");
  await click("Generate with AI");
  await aiDialog().get('[name="description"]').setValue("  Create a letter  ");
}

it("hides the drafting control when site-wide AI is disabled", async () => {
  aiEnabled = false;
  await open();
  await click("template.tex");
  expect(wrapper.find('[aria-label="Generate with AI"]').exists()).toBe(false);
});

it("offers AI drafting only for the saved root template file", async () => {
  await open("/templates/new");
  expect(wrapper.find('[aria-label="Generate with AI"]').exists()).toBe(false);
  await wrapper.unmount();
  await open();
  expect(wrapper.find('[aria-label="Generate with AI"]').exists()).toBe(false);
  await click("template.tex");
  expect(wrapper.find('[aria-label="Generate with AI"]').exists()).toBe(true);
  await wrapper.get('[aria-label="Expand parts"]').trigger("click");
  await click("header.tex");
  expect(wrapper.find('[aria-label="Generate with AI"]').exists()).toBe(false);
});

it("reviews the result before applying one undoable edit and saves only when asked", async () => {
  await open();
  await startAiDraft();
  await setEditorText(wrapper, "My unsaved TeX");
  expect(aiDialog().text()).toContain("Letter");
  expect(aiDialog().text()).toContain("name");
  await aiDialog().get('[name="pageSize"]').setValue("Letter");
  await aiDialog().get('[name="orientation"]').setValue("landscape");
  await aiDialog().get("form").trigger("submit");
  await flushPromises();
  const request = mutation("POST", "/letter/ai/draft")!;
  expect(JSON.parse(String(request.init.body))).toEqual({
    pageSize: "Letter",
    orientation: "landscape",
    description: "Create a letter",
  });
  expect(request.init.headers).toMatchObject({ "X-CSRF-Token": "csrf" });
  expect(
    aiDialog().get<HTMLTextAreaElement>("#ai-draft-tex").element.value,
  ).toBe("Generated TeX");
  const editor = editorView(wrapper);
  expect(editor.state.doc.toString()).toBe("My unsaved TeX");
  await click("Apply draft");
  expect(editor.state.doc.toString()).toBe("Generated TeX");
  expect(wrapper.text()).toContain("Unsaved changes");
  expect(mutation("PUT", "/files/text")).toBeUndefined();
  expect(undo(editor)).toBe(true);
  expect(editor.state.doc.toString()).toBe("My unsaved TeX");
  await flushPromises();
  expect(undo(editor)).toBe(true);
  expect(editor.state.doc.toString()).toBe("Hello");
  await flushPromises();
  expect(redo(editor)).toBe(true);
  await flushPromises();
  expect(redo(editor)).toBe(true);
  await flushPromises();
  await click("Save file");
  expect(JSON.parse(String(mutation("PUT", "/files/text")?.init.body))).toEqual(
    {
      segments: ["template.tex"],
      text: "Generated TeX",
    },
  );
});

it("modifies the current editor contents using only a change description", async () => {
  await open();
  await startAiDraft();
  await setEditorText(wrapper, "My unsaved TeX");
  await aiDialog()
    .get<HTMLInputElement>('[aria-label="Modify"]')
    .setValue(true);
  expect(aiDialog().find('[name="pageSize"]').exists()).toBe(false);
  expect(aiDialog().find('[name="orientation"]').exists()).toBe(false);
  expect(aiDialog().text()).toContain("Describe changes");
  await aiDialog().get('[name="description"]').setValue("Add a footer");
  await aiDialog().get("form").trigger("submit");
  await flushPromises();
  const request = mutation("POST", "/letter/ai/draft")!;
  expect(JSON.parse(String(request.init.body))).toEqual({
    source: "My unsaved TeX",
    description: "Add a footer",
  });
  const editor = editorView(wrapper);
  expect(editor.state.doc.toString()).toBe("My unsaved TeX");
  await click("Apply draft");
  expect(editor.state.doc.toString()).toBe("Generated TeX");
  expect(mutation("PUT", "/files/text")).toBeUndefined();
});

it("shows a size error before submitting an oversized Modify request", async () => {
  await open();
  await startAiDraft();
  await setEditorText(wrapper, "\\".repeat(512 * 1024));
  await aiDialog()
    .get<HTMLInputElement>('[aria-label="Modify"]')
    .setValue(true);
  await aiDialog().get('[name="description"]').setValue("Add a footer");
  await aiDialog().get("form").trigger("submit");
  await flushPromises();
  expect(aiDialog().get('[role="alert"]').text()).toContain("1 MiB");
  expect(mutation("POST", "/letter/ai/draft")).toBeUndefined();
});

it.each([
  [429, "User AI quota exceeded"],
  [422, "Describe the LaTeX template you want to generate."],
  [503, "AI drafting is unavailable."],
])(
  "shows a %s drafting error without changing the file",
  async (status, error) => {
    await open();
    await startAiDraft();
    draftResponse = async () => Response.json({ error }, { status });
    await aiDialog().get("form").trigger("submit");
    await flushPromises();
    expect(aiDialog().get('[role="alert"]').text()).toBe(error);
    expect(editorView(wrapper).state.doc.toString()).toBe("Hello");
  },
);

it("prevents duplicate submissions and ignores a result after cancel", async () => {
  await open();
  await startAiDraft();
  let finish!: (response: Response) => void;
  draftResponse = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const form = aiDialog().get("form");
  await form.trigger("submit");
  await form.trigger("submit");
  expect(calls.filter(({ path }) => path.endsWith("/ai/draft"))).toHaveLength(
    1,
  );
  expect(aiDialog().get('[role="status"]').text()).toContain("Generating");
  await click("Cancel");
  finish(Response.json({ tex: "Late draft" }));
  await flushPromises();
  expect(wrapper.find("dialog[open]").exists()).toBe(false);
  expect(editorView(wrapper).state.doc.toString()).toBe("Hello");
});

it("prevents applying a draft after the editor changes, even if the text is restored", async () => {
  await open();
  await startAiDraft();
  let finish!: (response: Response) => void;
  draftResponse = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  await aiDialog().get("form").trigger("submit");
  await setEditorText(wrapper, "New edit");
  await setEditorText(wrapper, "Hello");
  finish(Response.json({ tex: "Stale draft" }));
  await flushPromises();
  expect(aiDialog().get('[role="alert"]').text()).toContain("changed");
  expect(aiDialog().get("button[disabled]").text()).toBe("Apply draft");
  expect(editorView(wrapper).state.doc.toString()).toBe("Hello");
});

it.each(["file", "route"])(
  "ignores a pending result after %s navigation",
  async (kind) => {
    const router = await open();
    await wrapper.get('[aria-label="Expand parts"]').trigger("click");
    await startAiDraft();
    let finish!: (response: Response) => void;
    draftResponse = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    await aiDialog().get("form").trigger("submit");
    if (kind === "file") await click("header.tex");
    else await router.push("/templates");
    await flushPromises();
    finish(Response.json({ tex: "Late draft" }));
    await flushPromises();
    expect(wrapper.find("dialog[open]").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("Late draft");
  },
);
