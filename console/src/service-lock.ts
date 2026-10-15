import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

/** Require the live Linux flock inherited through exec; an environment flag cannot confer ownership. */
export async function requireWriterLock(stateParent: string): Promise<void> {
  if (process.platform !== "linux" || process.getuid === undefined || process.getuid() === 0) throw new Error("Hosted writer lock requires native non-root Linux under the reviewed service unit");
  const directory = await lstat(stateParent);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() || (directory.mode & 0o077) !== 0 || await realpath(stateParent) !== stateParent) {
    throw new Error("Hosted writer lock requires an owned, private, real state parent directory with mode 0700");
  }
  const lock = await lstat(path.join(stateParent, "writer.lock"));
  if (!lock.isFile() || lock.isSymbolicLink() || lock.uid !== process.getuid() || (lock.mode & 0o077) !== 0 || lock.nlink !== 1) throw new Error("Hosted writer lock must be one owned, private regular file");
  for (const name of await readdir("/proc/self/fdinfo")) {
    const info = await readFile(`/proc/self/fdinfo/${name}`, "utf8");
    if (!new RegExp(`lock:\\s+\\d+:\\s+FLOCK\\s+ADVISORY\\s+WRITE\\s+${process.pid}\\s`).test(info)) continue;
    const owned = await stat(`/proc/self/fd/${name}`);
    if (owned.dev === lock.dev && owned.ino === lock.ino) return;
  }
  throw new Error("Hosted writer lock is not held by this process. Start with the reviewed flock --nonblock --no-fork service unit; never bypass supervision");
}
