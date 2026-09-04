import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../api/v2", () => ({
  isTauriV2: () => true,
}));

import { invoke } from "@tauri-apps/api/core";
import { loadShellIcon, peekShellIcon } from "./shellImages";

describe("shell icon loading", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("batches distinct extension requests into one desktop command", async () => {
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      expect(command).toBe("file_icons");
      const extensions = (args as { extensions: string[] }).extensions;
      return Object.fromEntries(extensions.map((extension) => [
        extension,
        `data:image/png;base64,${extension}`,
      ]));
    });

    const [pdf, docx, zip] = await Promise.all([
      loadShellIcon("batch_pdf"),
      loadShellIcon("batch_docx"),
      loadShellIcon("batch_zip"),
    ]);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("file_icons", {
      extensions: ["batch_pdf", "batch_docx", "batch_zip"],
    });
    expect(pdf).toBe("data:image/png;base64,batch_pdf");
    expect(docx).toBe("data:image/png;base64,batch_docx");
    expect(zip).toBe("data:image/png;base64,batch_zip");
    expect(peekShellIcon("batch_pdf")).toBe(pdf);
  });

  it("deduplicates simultaneous requests for the same extension", async () => {
    vi.mocked(invoke).mockResolvedValue({
      batch_shared: "data:image/png;base64,shared",
    });

    const values = await Promise.all([
      loadShellIcon("batch_shared"),
      loadShellIcon(".BATCH_SHARED"),
      loadShellIcon("batch_shared"),
    ]);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("file_icons", {
      extensions: ["batch_shared"],
    });
    expect(values).toEqual(Array(3).fill("data:image/png;base64,shared"));
  });

  it("falls back to the single-icon command during a backend restart", async () => {
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "file_icons") throw new Error("unknown command");
      const extension = (args as { extension: string }).extension;
      return `data:image/png;base64,${extension}`;
    });

    await expect(loadShellIcon("batch_legacy")).resolves.toBe(
      "data:image/png;base64,batch_legacy",
    );
    expect(invoke).toHaveBeenNthCalledWith(1, "file_icons", {
      extensions: ["batch_legacy"],
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "file_icon", {
      extension: "batch_legacy",
    });
  });
});
