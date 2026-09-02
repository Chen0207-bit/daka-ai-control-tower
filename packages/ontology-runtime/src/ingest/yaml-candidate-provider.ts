import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { CandidateFactProvider } from "../actions/handlers";

/**
 * YAML CandidateFactProvider：真实 Semantica/OCR/LLM 缺席时的可运行替身。
 * 契约边界：产出物只会进入 proposed（handler 落库时硬编码 status='proposed'），
 * 该 provider 无法触碰 verified 事实、付款或库存。
 * 未来接 Semantica 时实现同一接口即可替换，不改本体与页面。
 */
export class YamlCandidateProvider implements CandidateFactProvider {
  constructor(private readonly candidatesPath: string) {}

  async extract(input: { contractId: string; extractorVersion: string }) {
    const doc = parseYaml(readFileSync(this.candidatesPath, "utf8")) as {
      candidates?: Array<{
        contractId: string;
        predicate: string;
        objectValue: unknown;
        confidence?: number;
        locator: Record<string, unknown>;
        excerptHash?: string;
      }>;
    };
    void input.extractorVersion;
    return (doc.candidates ?? []).filter((c) => c.contractId === input.contractId);
  }
}
