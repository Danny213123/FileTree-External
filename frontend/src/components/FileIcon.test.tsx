import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/shellImages", () => ({
  loadShellIcon: vi.fn(),
  loadShellThumbnail: vi.fn(),
}));

import { loadShellIcon, loadShellThumbnail } from "../lib/shellImages";
import { FileIcon } from "./FileIcon";

describe("FileIcon", () => {
  beforeEach(() => {
    vi.mocked(loadShellIcon).mockReset().mockResolvedValue(null);
    vi.mocked(loadShellThumbnail).mockReset().mockResolvedValue(null);
  });

  it("does not eagerly generate thumbnails for ordinary media rows", async () => {
    render(
      <FileIcon
        ext="mp4"
        path="D:\\Downloads\\clip.mp4"
        isDir={false}
        isBundle={false}
      />,
    );

    await waitFor(() => expect(loadShellIcon).toHaveBeenCalledWith("mp4"));
    expect(loadShellThumbnail).not.toHaveBeenCalled();
  });

  it("uses a neutral file glyph instead of an archive extension badge", async () => {
    const view = render(
      <FileIcon ext="rar" path="D:\\Downloads\\archive.rar" isDir={false} isBundle={false} />,
    );

    await waitFor(() => expect(loadShellIcon).toHaveBeenCalledWith("rar"));
    expect(view.queryByText("RAR")).not.toBeInTheDocument();
    expect(view.container.querySelector(".kind-file-generic")).toBeInTheDocument();
  });
});
