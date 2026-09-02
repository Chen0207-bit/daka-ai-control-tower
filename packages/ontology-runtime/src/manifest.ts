import { readFileSync } from "node:fs";
import type { CanonicalIR } from "@daka/ontology-dsl";
import { RUNTIME_ERRORS, RuntimeError } from "./errors";

/** Runtime 清单 = Canonical IR + fingerprint。加载时校验 dsl major。 */
export interface RuntimeManifest extends CanonicalIR {
  fingerprint: string;
}

const SUPPORTED_DSL_MAJORS = new Set(["1"]);

export function assertSupported(manifest: RuntimeManifest): void {
  const major = manifest.meta.dsl.split(".")[0];
  if (!SUPPORTED_DSL_MAJORS.has(major)) {
    throw new RuntimeError(
      RUNTIME_ERRORS.DSL_UNSUPPORTED,
      `不支持的 DSL major "${major}"；Runtime 支持: ${[...SUPPORTED_DSL_MAJORS].join(", ")}`,
    );
  }
}

export function loadManifest(path: string): RuntimeManifest {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as RuntimeManifest;
  assertSupported(parsed);
  return parsed;
}
