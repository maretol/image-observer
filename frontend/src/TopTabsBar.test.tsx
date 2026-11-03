// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newViewer } from "./features/viewer-grid/viewers";
import { TopTabsBar, type TopTabsBarProps } from "./TopTabsBar";

// トップタブ列の chrome はマウス操作で focus を受け取らない (#150)。focus が残ると次のキー操作で
// :focus-visible が点灯して「変な枠」になる。keyboard 経路 (Tab → Enter) は native focus のまま
// 通し、rename 入力の blur-commit (focus が離れることに乗った処理) は明示 blur で維持する。

const viewerA = { ...newViewer("A"), id: "a" };
const viewerB = { ...newViewer("B"), id: "b" };

function makeReorder(): TopTabsBarProps["reorder"] {
  return {
    state: null,
    containerRef: { current: null },
    startDrag: vi.fn(),
    shouldSuppressClick: () => false,
  };
}

function renderBar(overrides: Partial<TopTabsBarProps> = {}): TopTabsBarProps {
  const props: TopTabsBarProps = {
    topTab: "viewer",
    onSelectList: vi.fn(),
    viewers: [viewerA, viewerB],
    activeViewerId: "a",
    editingViewerId: null,
    onSelectViewer: vi.fn(),
    onStartRename: vi.fn(),
    onCommitRename: vi.fn(),
    onCancelRename: vi.fn(),
    onCloseViewer: vi.fn(),
    reorder: makeReorder(),
    onAddViewer: vi.fn(),
    onOpenSettings: vi.fn(),
    maxViewers: 8,
    ...overrides,
  };
  render(<TopTabsBar {...props} />);
  return props;
}

// 直前に focus を持っていた要素 (一覧の card など) の代役。
function focusDecoy(): HTMLInputElement {
  const decoy = document.createElement("input");
  decoy.className = "decoy";
  document.body.appendChild(decoy);
  decoy.focus();
  expect(document.activeElement).toBe(decoy);
  return decoy;
}

afterEach(() => {
  cleanup();
  document.querySelectorAll("input.decoy").forEach((el) => el.remove());
});

const nameTab = (name: string) => screen.getByRole("tab", { name });
const wrapperOf = (name: string) => nameTab(name).parentElement as HTMLElement;

const CHROME: Array<[string, () => HTMLElement]> = [
  ["list tab", () => screen.getByRole("tab", { name: "一覧" })],
  ["viewer name", () => nameTab("A")],
  ["close", () => screen.getByRole("button", { name: 'ビューア "A" を閉じる' })],
  ["add", () => screen.getByRole("button", { name: "ビューアを追加" })],
  ["settings", () => screen.getByRole("button", { name: "設定を開く" })],
];

describe("TopTabsBar mouse focus policy (#150)", () => {
  it.each(CHROME)(
    "mousedown on %s is default-prevented and drops the previous focus",
    (_label, pick) => {
      renderBar();
      const decoy = focusDecoy();
      const notPrevented = fireEvent.mouseDown(pick());
      expect(notPrevented).toBe(false);
      expect(document.activeElement).not.toBe(decoy);
    },
  );

  it("clicking the viewer tab wrapper activates it without focusing the name button", () => {
    const props = renderBar();
    fireEvent.click(wrapperOf("B"));
    expect(props.onSelectViewer).toHaveBeenCalledWith("b");
    expect(document.activeElement).not.toBe(nameTab("B"));
  });

  it("keyboard activation keeps focus on the name button (ring stays for keyboard users)", () => {
    const props = renderBar();
    const name = nameTab("B");
    name.focus();
    fireEvent.click(name); // Enter / Space は click に合成され、mousedown を経ない
    expect(props.onSelectViewer).toHaveBeenCalledWith("b");
    expect(document.activeElement).toBe(name);
  });

  it("pointerdown on the wrapper (drag path) drops the previous focus", () => {
    const props = renderBar();
    const decoy = focusDecoy();
    fireEvent.pointerDown(wrapperOf("B"), {
      button: 0,
      clientX: 10,
      clientY: 10,
      pointerId: 1,
    });
    expect(props.reorder.startDrag).toHaveBeenCalled();
    expect(document.activeElement).not.toBe(decoy);
  });

  it("mousedown on a sibling tab while renaming blurs the input so the rename commits", () => {
    const props = renderBar({ editingViewerId: "a" });
    const input = screen.getByRole("textbox", { name: "ビューア名を編集: A" });
    expect(document.activeElement).toBe(input);
    fireEvent.mouseDown(nameTab("B"));
    expect(props.onCommitRename).toHaveBeenCalledWith("a", "A");
    expect(document.activeElement).not.toBe(nameTab("B"));
  });

  it("mousedown on the list tab while renaming also commits the rename", () => {
    const props = renderBar({ editingViewerId: "a" });
    fireEvent.mouseDown(screen.getByRole("tab", { name: "一覧" }));
    expect(props.onCommitRename).toHaveBeenCalledWith("a", "A");
  });
});
