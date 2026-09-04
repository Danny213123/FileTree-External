import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/shellImages", () => ({
  loadShellIcon: vi.fn(),
  loadShellThumbnail: vi.fn(),
  peekShellIcon: vi.fn(),
  invalidateShellIcon: vi.fn(),
}));

import {
  invalidateShellIcon,
  loadShellIcon,
  loadShellThumbnail,
  peekShellIcon,
} from "../lib/shellImages";
import { FileIcon } from "./FileIcon";

describe("FileIcon", () => {
  beforeEach(() => {
    vi.mocked(loadShellIcon).mockReset().mockResolvedValue(null);
    vi.mocked(loadShellThumbnail).mockReset().mockResolvedValue(null);
    vi.mocked(peekShellIcon).mockReset().mockReturnValue(undefined);
    vi.mocked(invalidateShellIcon).mockReset();
  });

  it("uses the Windows file-type icon without generating a media thumbnail", async () => {
    render(
      <FileIcon
        ext="mp4"
        isDir={false}
        isBundle={false}
      />,
    );

    await waitFor(() => expect(loadShellIcon).toHaveBeenCalledWith("mp4"));
    expect(loadShellThumbnail).not.toHaveBeenCalled();
  });

  it("uses a neutral file glyph instead of an archive extension badge", async () => {
    const view = render(
      <FileIcon ext="rar" isDir={false} isBundle={false} />,
    );

    await waitFor(() => expect(loadShellIcon).toHaveBeenCalledWith("rar"));
    expect(view.queryByText("RAR")).not.toBeInTheDocument();
    expect(view.container.querySelector(".kind-file-generic")).toBeInTheDocument();
  });

  it("keeps an immediate document fallback until the shell icon decodes", async () => {
    let resolveIcon: (value: string | null) => void = () => {};
    vi.mocked(loadShellIcon).mockReturnValue(new Promise((resolve) => {
      resolveIcon = resolve;
    }));
    const view = render(
      <FileIcon ext="docx" isDir={false} isBundle={false} />,
    );

    const fallback = view.container.querySelector(".kind-file-generic")!;
    expect(fallback).toBeVisible();
    expect(view.container.querySelector(".kind-shell-icon")).toBeNull();

    resolveIcon("data:image/png;base64,icon");
    const image = await waitFor(() => {
      const element = view.container.querySelector<HTMLImageElement>(".kind-shell-icon");
      expect(element).not.toBeNull();
      return element!;
    });
    expect(fallback).not.toHaveClass("is-hidden");
    expect(image).not.toHaveClass("is-ready");

    fireEvent.load(image);
    expect(fallback).toHaveClass("is-hidden");
    expect(image).toHaveClass("is-ready");
  });

  it("uses a decoded extension cache on the first render", () => {
    vi.mocked(peekShellIcon).mockReturnValue("data:image/png;base64,cached");
    const view = render(
      <FileIcon ext="zip" isDir={false} isBundle={false} />,
    );

    expect(view.container.querySelector(".kind-shell-icon")).toHaveAttribute(
      "src",
      "data:image/png;base64,cached",
    );
    expect(loadShellIcon).not.toHaveBeenCalled();
  });

  it("invalidates an image that WebView cannot decode", () => {
    let cached: string | undefined = "data:image/png;base64,broken";
    vi.mocked(peekShellIcon).mockImplementation(() => cached);
    vi.mocked(invalidateShellIcon).mockImplementation(() => {
      cached = undefined;
    });
    const view = render(
      <FileIcon ext="pdf" isDir={false} isBundle={false} />,
    );
    fireEvent.error(view.container.querySelector(".kind-shell-icon")!);

    expect(invalidateShellIcon).toHaveBeenCalledWith("pdf");
    expect(view.container.querySelector(".kind-shell-icon")).toBeNull();
    expect(view.container.querySelector(".kind-file-generic")).not.toHaveClass("is-hidden");
  });
});
