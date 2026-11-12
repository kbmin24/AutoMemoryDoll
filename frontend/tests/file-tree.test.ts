import { expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import FileTree from "../src/components/FileTree.vue";

const files = [
  { name: "z.tex", kind: "file" as const, segments: ["z.tex"] },
  { name: "parts", kind: "directory" as const, segments: ["parts"] },
  {
    name: "header.tex",
    kind: "file" as const,
    segments: ["parts", "header.tex"],
  },
];
it("sorts folders first, collapses descendants, and selects the root", async () => {
  const tree = mount(FileTree, { props: { files, selected: "", busy: false } });
  expect(
    tree
      .findAll('[role="treeitem"]')
      .map((row) => row.attributes("aria-label")),
  ).toEqual(["parts", "z.tex"]);
  expect(tree.get('[aria-label="parts"]').attributes("aria-posinset")).toBe(
    "1",
  );
  expect(tree.get('[aria-label="parts"]').attributes("aria-setsize")).toBe("2");
  await tree.get('[aria-label="Expand parts"]').trigger("click");
  expect(tree.text()).toContain("header.tex");
  await tree.get('[aria-label="Collapse parts"]').trigger("click");
  expect(tree.text()).not.toContain("header.tex");
  await tree.get('[role="tree"]').trigger("click");
  expect(tree.emitted("select")?.[0]?.[0]).toMatchObject({
    segments: [],
    kind: "directory",
  });
  expect(tree.findAll('[role="treeitem"]')).toHaveLength(2);
});
it.each(["ArrowLeft", "Enter", " "])(
  "keeps the invisible root expanded after %s",
  async (key) => {
    const tree = mount(FileTree, {
      props: { files, selected: "", busy: false },
    });
    await tree.get('[role="tree"]').trigger("keydown", { key });
    expect(tree.findAll('[role="treeitem"]')).toHaveLength(2);
    tree.unmount();
  },
);
it("navigates visible rows with the keyboard", async () => {
  const tree = mount(FileTree, {
    attachTo: document.body,
    props: { files, selected: "", busy: false },
  });
  await tree.get('[role="tree"]').trigger("keydown", { key: "ArrowDown" });
  expect(document.activeElement?.getAttribute("aria-label")).toBe("parts");
  await tree
    .get('[aria-label="parts"]')
    .trigger("keydown", { key: "ArrowRight" });
  await tree
    .get('[aria-label="parts"]')
    .trigger("keydown", { key: "ArrowRight" });
  expect(document.activeElement?.getAttribute("aria-label")).toBe("header.tex");
  await tree
    .get('[aria-label="header.tex"]')
    .trigger("keydown", { key: "Enter" });
  expect(tree.emitted("select")?.[0]?.[0]).toMatchObject({
    name: "header.tex",
  });
  tree.unmount();
});
it("reveals an inline field, submits its name and cancels with Escape", async () => {
  const tree = mount(FileTree, {
    props: {
      files,
      selected: "",
      busy: false,
      draft: { kind: "file" as const, parent: ["parts"] },
    },
  });
  const input = tree.get('[aria-label="New file name"]');
  await input.setValue("new.tex");
  await input.trigger("keydown", { key: "Enter" });
  expect(tree.emitted("create")?.[0]).toEqual(["new.tex"]);
  await input.trigger("keydown", { key: "Escape" });
  expect(tree.emitted("cancel")).toHaveLength(1);
});
it("reveals a nested selection on mount and restores inline focus after a failed request", async () => {
  const tree = mount(FileTree, {
    attachTo: document.body,
    props: { files, selected: "parts/header.tex", busy: false },
  });
  expect(tree.get('[aria-label="header.tex"]').attributes("tabindex")).toBe(
    "0",
  );
  await tree.setProps({ draft: { kind: "file", parent: ["parts"] } });
  await flushPromises();
  expect(document.activeElement?.getAttribute("aria-label")).toBe(
    "New file name",
  );
  await tree.setProps({ busy: true });
  await tree.setProps({ busy: false });
  await flushPromises();
  expect(document.activeElement?.getAttribute("aria-label")).toBe(
    "New file name",
  );
  tree.unmount();
});

it("moves internal drags into folders and rejects protected, external, self and descendant drops", async () => {
  const tree = mount(FileTree, { props: { files, selected: "", busy: false } });
  const transfer = { setData() {}, effectAllowed: "" };
  await tree
    .get('[aria-label="z.tex"]')
    .trigger("dragstart", { dataTransfer: transfer });
  await tree
    .get('[aria-label="parts"]')
    .trigger("dragover", { dataTransfer: { dropEffect: "" } });
  await tree.get('[aria-label="parts"]').trigger("drop");
  expect(tree.emitted("move")?.[0]).toEqual([files[0], ["parts"]]);
  await tree.get('[aria-label="parts"]').trigger("drop");
  expect(tree.emitted("move")).toHaveLength(1);
  await tree
    .get('[aria-label="parts"]')
    .trigger("dragstart", { dataTransfer: transfer });
  await tree.get('[aria-label="parts"]').trigger("drop");
  expect(tree.emitted("move")).toHaveLength(1);
  tree.unmount();
});
it("offers downloads only for files and closes menus when their container scrolls", async () => {
  const tree = mount(FileTree, {
    attachTo: document.body,
    props: {
      files,
      selected: "",
      busy: false,
      downloadBase: "/api/templates/letter/files/download",
    },
    global: { stubs: { teleport: true } },
  });
  await tree.get('[aria-label="Actions for z.tex"]').trigger("click");
  expect(tree.get("a[download]").attributes("href")).toBe(
    "/api/templates/letter/files/download?segments=z.tex",
  );
  await tree.get('[role="tree"]').trigger("scroll");
  expect(tree.find("a[download]").exists()).toBe(false);
  await tree.get('[aria-label="Actions for parts"]').trigger("click");
  expect(tree.find("a[download]").exists()).toBe(false);
  expect(tree.find('[aria-label="Move item"]').exists()).toBe(true);
  tree.unmount();
});
it("rejects protected and descendant drags and supports moving to root with the keyboard", async () => {
  const protectedFile = {
    name: "template.tex",
    kind: "file" as const,
    segments: ["template.tex"],
  };
  const child = {
    name: "sub",
    kind: "directory" as const,
    segments: ["parts", "sub"],
  };
  const tree = mount(FileTree, {
    props: {
      files: [...files, protectedFile, child],
      selected: "parts/header.tex",
      busy: false,
    },
  });
  const transfer = { setData() {}, effectAllowed: "" };
  await tree
    .get('[aria-label="template.tex"]')
    .trigger("dragstart", { dataTransfer: transfer });
  await tree.get('[aria-label="parts"]').trigger("drop");
  expect(tree.emitted("move")).toBeUndefined();
  await tree
    .get('[aria-label="parts"]')
    .trigger("dragstart", { dataTransfer: transfer });
  await tree.get('[aria-label="sub"]').trigger("drop");
  expect(tree.emitted("move")).toBeUndefined();
  await tree
    .get('[aria-label="header.tex"]')
    .trigger("keydown", { key: "x", ctrlKey: true });
  await tree
    .get('[role="tree"]')
    .trigger("keydown", { key: "v", ctrlKey: true });
  expect(tree.emitted("move")?.[0]).toEqual([files[2], []]);
  await tree.setProps({ busy: true });
  await tree
    .get('[aria-label="z.tex"]')
    .trigger("dragstart", { dataTransfer: transfer });
  await tree.get('[aria-label="parts"]').trigger("drop");
  expect(tree.emitted("move")).toHaveLength(1);
  tree.unmount();
});

it("prevents external file drops from navigating away without moving workspace items", async () => {
  const tree = mount(FileTree, { props: { files, selected: "", busy: false } });
  const event = new Event("dragover", { bubbles: true, cancelable: true });
  tree.get('[aria-label="parts"]').element.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  await tree.get('[aria-label="parts"]').trigger("drop");
  expect(tree.emitted("move")).toBeUndefined();
  tree.unmount();
});
