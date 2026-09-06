import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DuplicateDeletionDialog } from "./DuplicateDeletionDialog";

afterEach(cleanup);

describe("DuplicateDeletionDialog", () => {
  it("defaults to Recycle Bin and submits a recycle request", () => {
    const onConfirm = vi.fn();
    render(
      <DuplicateDeletionDialog
        fileCount={1}
        groupCount={1}
        bytes={1024}
        linkEligible
        unverifiedCount={0}
        pending={false}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByText(/Send to Recycle Bin/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Move to Recycle Bin" }));
    expect(onConfirm).toHaveBeenCalledWith({ permanent: false });
  });

  it("can permanently delete and replace the path with a hard link", () => {
    const onConfirm = vi.fn();
    render(
      <DuplicateDeletionDialog
        fileCount={2}
        groupCount={1}
        bytes={4096}
        linkEligible
        unverifiedCount={0}
        pending={false}
        initialPermanent
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByLabelText(/Replace with a link/i));
    fireEvent.click(screen.getByRole("button", { name: "Delete and hard-link" }));
    expect(onConfirm).toHaveBeenCalledWith({
      permanent: true,
      replaceWithLink: "hardlink",
    });
  });

  it("disables link replacement when the selection is not content-verified", () => {
    render(
      <DuplicateDeletionDialog
        fileCount={2}
        groupCount={1}
        bytes={4096}
        linkEligible={false}
        unverifiedCount={2}
        pending={false}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(screen.getByText(/2 marked files are not content-verified/)).toBeInTheDocument();
  });
});
