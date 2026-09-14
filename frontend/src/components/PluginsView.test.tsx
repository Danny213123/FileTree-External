import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluginsView } from "./PluginsView";
import { PLUGINS, canOptIn, loadPluginPrefs, type PluginPanelProps } from "../lib/plugins";

const shippable = PLUGINS.find((d) => canOptIn(d))!;
const planned = PLUGINS.find((d) => !canOptIn(d));

/** The catalog card for a plugin, found by its heading. */
function cardFor(name: string): HTMLElement {
  return screen.getByRole("heading", { name }).closest("article")!;
}

afterEach(cleanup);

describe("PluginsView", () => {
  beforeEach(() => localStorage.clear());

  it("lists the catalog first, then a tab per plugin", () => {
    render(<PluginsView />);

    const tabs = within(screen.getByRole("tablist")).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual([
      `Catalog0/${PLUGINS.length}`,
      ...PLUGINS.map((d) => d.name),
    ]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
  });

  it("starts with everything opted out", () => {
    render(<PluginsView />);

    expect(screen.getAllByRole("button", { name: "Opt in" })).toHaveLength(
      PLUGINS.filter(canOptIn).length,
    );
    expect(screen.queryByText("Enabled")).not.toBeInTheDocument();
  });

  it("opts in from the catalog and persists the choice", () => {
    render(<PluginsView />);

    const card = cardFor(shippable.name);
    fireEvent.click(within(card).getByRole("button", { name: "Opt in" }));

    expect(within(card).getByText("Enabled")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Opt out" })).toBeInTheDocument();
    expect(loadPluginPrefs()[shippable.id]?.enabled).toBe(true);
  });

  it("opting back out clears the stored consent flag", () => {
    render(<PluginsView />);

    const card = cardFor(shippable.name);
    fireEvent.click(within(card).getByRole("button", { name: "Opt in" }));
    fireEvent.click(within(card).getByRole("button", { name: "Opt out" }));

    expect(loadPluginPrefs()[shippable.id]?.enabled).toBe(false);
    expect(within(card).getByRole("button", { name: "Opt in" })).toBeInTheDocument();
  });

  it("explains what the plugin needs and does while it is off", () => {
    render(<PluginsView />);

    fireEvent.click(screen.getByRole("tab", { name: shippable.name }));
    expect(screen.getByRole("heading", { name: "What it needs from FileTree" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "What it does" })).toBeInTheDocument();
    for (const line of shippable.needs) expect(screen.getByText(line)).toBeInTheDocument();
    for (const line of shippable.provides) expect(screen.getByText(line)).toBeInTheDocument();
  });

  it("hands the tab body over to the plugin once it is enabled", () => {
    render(<PluginsView />);

    fireEvent.click(screen.getByRole("tab", { name: shippable.name }));
    fireEvent.click(screen.getByRole("button", { name: "Opt in" }));

    // FileTree's own description gets out of the way...
    expect(screen.queryByRole("heading", { name: "What it needs from FileTree" })).not.toBeInTheDocument();
    expect(screen.queryByText(shippable.about)).not.toBeInTheDocument();
    // ...leaving the plugin's area and a way back out.
    expect(screen.getByRole("heading", { name: `${shippable.name} draws here` })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Opt out" })).toBeInTheDocument();
  });

  it("renders a plugin's own panel when it ships one", () => {
    const Panel = ({ plugin }: PluginPanelProps) => <div>live panel for {plugin.name}</div>;
    PLUGINS.push({
      id: "panelled",
      name: "Panelled",
      vendor: "test",
      icon: "tools",
      status: "available",
      summary: "s",
      about: "a",
      needs: ["n"],
      provides: ["p"],
      panel: Panel,
    });

    try {
      render(<PluginsView />);
      fireEvent.click(screen.getByRole("tab", { name: "Panelled" }));
      fireEvent.click(screen.getByRole("button", { name: "Opt in" }));

      expect(screen.getByText("live panel for Panelled")).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Panelled draws here" })).not.toBeInTheDocument();
    } finally {
      PLUGINS.pop();
    }
  });

  it("tracks how many are on in the catalog tab badge", () => {
    render(<PluginsView />);

    const catalogTab = screen.getByRole("tab", { name: /^Catalog/ });
    expect(catalogTab).toHaveTextContent(`0/${PLUGINS.length}`);

    fireEvent.click(within(cardFor(shippable.name)).getByRole("button", { name: "Opt in" }));
    expect(catalogTab).toHaveTextContent(`1/${PLUGINS.length}`);
  });

  it("restores opt-ins saved by a previous session", () => {
    localStorage.setItem(
      "filetree_plugins",
      JSON.stringify({ [shippable.id]: { enabled: true, since: Date.UTC(2026, 0, 2) } }),
    );
    render(<PluginsView />);

    expect(within(cardFor(shippable.name)).getByText("Enabled")).toBeInTheDocument();
  });

  it("lists planned plugins but refuses to turn them on", () => {
    if (!planned) return;
    render(<PluginsView />);

    const card = cardFor(planned.name);
    expect(within(card).getByRole("button", { name: "Not available yet" })).toBeDisabled();

    fireEvent.click(within(card).getByRole("button", { name: "Not available yet" }));
    expect(loadPluginPrefs()[planned.id]).toBeUndefined();
  });

  it("jumps to a plugin's tab from its catalog card", () => {
    render(<PluginsView />);

    fireEvent.click(within(cardFor(shippable.name)).getByRole("button", { name: "Details" }));

    expect(screen.getByRole("tab", { name: shippable.name })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText(shippable.about)).toBeInTheDocument();
  });
});
