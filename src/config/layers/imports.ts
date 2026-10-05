/**
 * The imports layer: `imports/*.mapping.yaml`. In slice 2 only the SHAPE is defined and
 * validated (FR-001, FR-005); nothing reads the data files a mapping names and nothing
 * imports — import execution is slice 3.
 */
import { listLayerFiles, readLayerFile, validateLayerFile } from "./files.js";

/** Validate every mapping under `dir`; returns the (config-relative) files that were validated. */
export function loadImportMappings(dir: string, baseDir: string): string[] {
  const validated: string[] = [];
  for (const file of listLayerFiles(dir, baseDir, false, ".mapping")) {
    validateLayerFile("ImportMapping", "imports", file, readLayerFile(file));
    validated.push(file.rel);
  }
  return validated;
}
