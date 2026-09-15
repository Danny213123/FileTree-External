import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Breadcrumb } from "./Breadcrumb";

afterEach(cleanup);
beforeEach(() => localStorage.setItem("filetree_recent_paths", JSON.stringify(["D:\\Media", "E:\\Backups"])));

describe("Breadcrumb recent locations", () => {
  it("opens the menu outside the clipped breadcrumb bar and navigates to a pick", () => {
    const onNavigate = vi.fn();
    render(
      <Breadcrumb path="C:\\Program Files" scanning={false} canBack={false} canForward={false} canUp
        onNavigate={onNavigate} onBack={vi.fn()} onForward={vi.fn()} onUp={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Recent locations" }));

    const menu = screen.getByRole("menu");
    // The bar has overflow:hidden; an absolutely positioned menu inside it was invisible.
    expect(menu.style.position).toBe("fixed");
    fireEvent.click(within(menu).getByTitle("E:\\Backups"));
    expect(onNavigate).toHaveBeenCalledWith("E:\\Backups");
  });
});
