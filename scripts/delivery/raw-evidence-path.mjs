import { resolve, relative, isAbsolute, sep } from "node:path";
import { normalizeRepositoryPath } from "./core.mjs";

export function resolveRawEvidencePath(rawRoot, rawPath, caseId) {
  const root = resolve(rawRoot);
  const normalized = normalizeRepositoryPath(rawPath);
  const path = resolve(root, ...normalized.split("/"));
  const descendant = relative(root, path);
  if (!descendant || descendant === ".." || descendant.startsWith(".." + sep) || isAbsolute(descendant)) {
    throw new Error("raw evidence path escapes root for " + caseId);
  }
  return path;
}
