import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { buildDataPack, type DataPack } from "./datapack";

/** 从目录加载 pack（Node 环境；Worker 用 buildDataPack 直接吃请求体）。 */
export function loadDataPack(dir: string): DataPack {
  const read = (name: string): unknown => {
    try {
      return parseYaml(readFileSync(join(dir, name), "utf8"));
    } catch {
      return undefined;
    }
  };
  return buildDataPack({
    pack: (read("pack.yaml") as Record<string, unknown> | undefined)?.pack,
    objects: ((read("objects.yaml") as Record<string, unknown>)?.objects ?? []),
    links: ((read("links.yaml") as Record<string, unknown>)?.links ?? []),
    facts: ((read("facts.yaml") as Record<string, unknown>)?.facts ?? []),
    documents: ((read("documents.yaml") as Record<string, unknown>)?.documents ?? []),
    anchors: ((read("documents.yaml") as Record<string, unknown>)?.anchors ?? []),
  });
}

export function listPackFiles(dir: string): string[] {
  return readdirSync(dir).filter((n) => n.endsWith(".yaml") || n.endsWith(".yml")).sort();
}
