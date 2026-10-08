import { promises as fs } from "node:fs";
import path from "node:path";
import { isSafeId } from "@steplight/core";

/** Raised for any invalid or unsafe action input; the message is shown to the user. */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

/** Resolve the deepest existing ancestor of `target` through symlinks, then re-append the rest. */
async function realpathLoose(target: string): Promise<string> {
  const rest: string[] = [];
  let current = target;
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return path.join(real, ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target;
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

const inside = (root: string, target: string): boolean => {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/**
 * Resolve a user-supplied path and require it to stay inside the workspace, also after symlinks are followed.
 * @throws InputError for empty paths, NUL bytes, `..` escapes, absolute paths elsewhere and symlink escapes.
 * @example const dir = await resolveInside("/home/runner/work/app/app", ".steplight/runs", "runs-dir")
 */
export async function resolveInside(workspace: string, input: string, label: string): Promise<string> {
  if (input.length === 0) throw new InputError(`${label} must not be empty`);
  if (input.includes("\0")) throw new InputError(`${label} contains an invalid character`);
  const root = await realpathLoose(path.resolve(workspace));
  const lexical = path.resolve(root, input);
  if (!inside(root, lexical)) throw new InputError(`${label} must stay inside the workspace ("${input}" does not)`);
  const real = await realpathLoose(lexical);
  if (!inside(root, real)) throw new InputError(`${label} must stay inside the workspace (it resolves outside through a symbolic link)`);
  return real;
}

/**
 * Validate a run id (the same rule the CLI and server use for folder names).
 * @throws InputError when the id could address anything but a run folder.
 */
export function validateRunId(id: string): string {
  if (!isSafeId(id)) throw new InputError('run-id may only contain letters, digits, "-" and "_" (max 128 characters)');
  return id;
}
