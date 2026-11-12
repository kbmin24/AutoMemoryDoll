import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createMemoryHistory } from "vue-router";
import { createAppRouter } from "../src/router";
import App from "../src/App.vue";
import type { TreeEntry } from "../src/api/types";
import { session } from "../src/api/client";

let wrapper: VueWrapper;
let calls: { path: string; init: RequestInit }[];
let shape: unknown;
let failSave = false;
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
beforeEach(() => {
  calls = [];
  workspaceFiles = [
    { name: "template.tex", kind: "file", segments: ["template.tex"] },
    { name: "logo.png", kind: "file", segments: ["logo.png"] },
    { name: "parts", kind: "directory", segments: ["parts"] },
    { name: "header.tex", kind: "file", segments: ["parts", "header.tex"] },
  ];
  shape = { fields: [field] };
  failSave = false;
  session.user = null;
  vi.stubGlobal(
    "confirm",
    vi.fn(() => false),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit = {}) => {
      calls.push({ path, init });
      let data: unknown = {};
      let status = 200;
      if (path === "/api/auth/me")
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
  await wrapper.get('[aria-label="File content"]').setValue("changed");
  await click("Save file");
  expect(JSON.parse(String(mutation("PUT", "/text")!.init.body)).text).toBe(
    "changed",
  );
  await wrapper.get('[aria-label="File content"]').setValue("changed again");
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
it("warns before discarding edits when selecting a file or leaving", async () => {
  const router = await open();
  await click("template.tex");
  await wrapper.get('[aria-label="File content"]').setValue("unsaved");
  await click("logo.png");
  expect(
    wrapper.get<HTMLTextAreaElement>('[aria-label="File content"]').element
      .value,
  ).toBe("unsaved");
  await router.push("/templates");
  expect(router.currentRoute.value.path).toBe("/templates/letter/edit");
  expect(window.confirm).toHaveBeenCalled();
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
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
  expect(
    wrapper.get<HTMLTextAreaElement>('[aria-label="File content"]').element
      .value,
  ).toBe("Hello");
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
  await wrapper.get('[aria-label="File content"]').setValue("unsaved");
  await click("Create ▾");
  await click("New file");
  expect(wrapper.find('[aria-label="New file name"]').exists()).toBe(false);
  expect(
    wrapper.get<HTMLTextAreaElement>('[aria-label="File content"]').element
      .value,
  ).toBe("unsaved");
});
it("guards edits made after inline creation began", async () => {
  await open();
  await click("template.tex");
  await click("Create ▾");
  await click("New file");
  await wrapper
    .get('[aria-label="File content"]')
    .setValue("changed while naming");
  await wrapper.get('[aria-label="New file name"]').setValue("new.tex");
  await wrapper
    .get('[aria-label="New file name"]')
    .trigger("keydown", { key: "Enter" });
  await flushPromises();
  expect(mutation("PUT", "/text")).toBeUndefined();
  expect(
    wrapper.get<HTMLTextAreaElement>('[aria-label="File content"]').element
      .value,
  ).toBe("changed while naming");
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
  expect(
    wrapper.get<HTMLTextAreaElement>('[aria-label="File content"]').element
      .value,
  ).toBe("Hello");
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
  await wrapper.get('[aria-label="File content"]').setValue("unsaved");
  const drag = () =>
    wrapper.get('[aria-label="logo.png"]').trigger("dragstart", {
      dataTransfer: { setData() {}, effectAllowed: "" },
    });
  await drag();
  await wrapper.get('[aria-label="parts"]').trigger("drop");
  await flushPromises();
  expect(mutation("POST", "/move")).toBeUndefined();
  vi.mocked(window.confirm).mockReturnValue(true);
  failSave = true;
  await drag();
  await wrapper.get('[aria-label="parts"]').trigger("drop");
  await flushPromises();
  expect(wrapper.text()).toContain("Storage limit exceeded");
  expect(
    wrapper.get<HTMLTextAreaElement>('[aria-label="File content"]').element
      .value,
  ).toBe("unsaved");
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
