import type { NotebookManifest, PageManifest, SectionManifest } from "./canonical-format.js";

/** A section and its ordered, lightweight page manifests. */
export interface NotebookSection {
  readonly manifest: SectionManifest;
  readonly pages: readonly PageManifest[];
}

/** Complete notebook navigation data in canonical section and page order. */
export interface NotebookHierarchy {
  readonly notebook: NotebookManifest;
  readonly sections: readonly NotebookSection[];
}
