import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActivityBar } from "./ActivityBar";

describe("ActivityBar", () => {
  it("opens the compression workspace from the primary navigation", () => {
    const onSelect = vi.fn();

    render(
      <ActivityBar
        activeView="explorer"
        sidebarOpen
        onSelect={onSelect}
        bookmarkCount={0}
        errorCount={0}
        darkMode
        onToggleTheme={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Compress" }));

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith("compress");
  });

  it("keeps Treemap out of the primary activity navigation", () => {
    render(
      <ActivityBar
        activeView="explorer"
        sidebarOpen
        onSelect={vi.fn()}
        bookmarkCount={0}
        errorCount={0}
        darkMode
        onToggleTheme={() => {}}
      />,
    );

    expect(screen.queryByRole("button", { name: "Treemap" })).not.toBeInTheDocument();
  });
});
