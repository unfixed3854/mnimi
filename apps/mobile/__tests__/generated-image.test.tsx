jest.mock("expo-file-system", () => ({ File: jest.fn(), Paths: { cache: "/tmp" } }));
jest.mock("@/api/media", () => ({
  fetchAuthenticatedMedia: jest.fn(),
  imageMediaPath: jest.fn(),
}));
jest.mock("@/lib/media-resource", () => ({
  createMediaResource: () => ({ uri: "file:///image.png", release: jest.fn() }),
}));

import { act, fireEvent, render } from "@testing-library/react-native";
import { fetchAuthenticatedMedia } from "@/api/media";
import { GeneratedImage, generatedImageClassName } from "@/components/generated-image";

describe("GeneratedImage layout", () => {
  it("keeps the saved-note default and allows a primary creation image", () => {
    expect(generatedImageClassName()).toContain("h-48 w-48");
    expect(generatedImageClassName("h-72 w-full")).toContain("h-72 w-full");
  });

  it("keeps loading announced until the downloaded image renders", async () => {
    let finishDownload!: (bytes: Uint8Array) => void;
    jest.mocked(fetchAuthenticatedMedia).mockReturnValue(new Promise((resolve) => {
      finishDownload = resolve;
    }));
    const onStatusChange = jest.fn();
    const view = await render(
      <GeneratedImage scope="drafts" id="draft" present alt="House" onStatusChange={onStatusChange} />,
    );
    await act(async () => { finishDownload(new Uint8Array([1])); });
    expect(view.getByRole("progressbar")).toBeTruthy();
    expect(onStatusChange).not.toHaveBeenCalledWith("ready");

    await fireEvent(view.getByLabelText("House", { includeHiddenElements: true }), "load");
    expect(view.queryByRole("progressbar")).toBeNull();
    expect(view.getByLabelText("House")).toBeTruthy();
    expect(onStatusChange).toHaveBeenLastCalledWith("ready");
  });

  it.each(["download", "decode"])("removes the loading placeholder after a %s failure", async (failure) => {
    if (failure === "download") {
      jest.mocked(fetchAuthenticatedMedia).mockRejectedValue(new Error("Offline"));
    } else {
      jest.mocked(fetchAuthenticatedMedia).mockResolvedValue(new Uint8Array([1]));
    }
    const onStatusChange = jest.fn();
    const view = await render(
      <GeneratedImage scope="notes" id="note" present alt="House" onStatusChange={onStatusChange} />,
    );
    if (failure === "decode") {
      await fireEvent(view.getByLabelText("House", { includeHiddenElements: true }), "error");
    }
    expect(view.queryByRole("progressbar")).toBeNull();
    expect(view.queryByLabelText("House")).toBeNull();
    expect(onStatusChange).toHaveBeenLastCalledWith("error");
  });
});
