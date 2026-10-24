// The recall declaration's folder read (RAI-313): star.yaml from a folder, through the kernel's parser.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { recallDeclarationFromText, type RecallDeclarationRead } from "funes-core/internal";

export function readRecallDeclaration(root: string): RecallDeclarationRead {
  let text: string;
  try { text = readFileSync(join(root, "star.yaml"), "utf8"); } catch { return { kind: "absent" }; }
  return recallDeclarationFromText(text);
}
