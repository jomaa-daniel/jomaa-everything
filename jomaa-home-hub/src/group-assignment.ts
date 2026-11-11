import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseConfig, type Config } from "./config.js";
import type { NodeSummary } from "./matter/nodes.js";

/** Saves room membership with the onboarding script's config lock. */
export function assignMatterGroup(path: string, node: NodeSummary, groupId: string | null): Promise<Config> {
  return editLayout(path, {
    action: "assign",
    nodeId: node.nodeId,
    endpoints: node.lightEndpoints,
    name: node.label || node.product || `Matter device ${node.nodeId}`,
    groupIds: groupId === null ? [] : [groupId],
    targetIds: [],
  });
}

export function editLayout(path: string, operation: Record<string, unknown>): Promise<Config> {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const script = fileURLToPath(new URL("../scripts/assign_matter_group.py", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = execFile(
      "python3",
      [script, path, root],
      { timeout: 15_000, maxBuffer: 1 << 20 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || "group assignment failed"));
          return;
        }
        try {
          resolve(parseConfig(stdout));
        } catch (reason) {
          reject(reason instanceof Error ? reason : new Error(String(reason)));
        }
      },
    );
    child.stdin?.end(JSON.stringify(operation));
  });
}
