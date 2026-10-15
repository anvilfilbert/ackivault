import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

function ownedLock(line: string, device: bigint, inode: bigint, pid: number): boolean {
  const record = /^\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+(\d+)\s+([0-9a-f]+):([0-9a-f]+):(\d+)\s+0\s+EOF$/.exec(line.trim());
  if (record === null || Number(record[1]) !== pid || BigInt(record[4]!) !== inode) return false;
  const major = ((device >> 8n) & 0xfffn) | ((device >> 32n) & 0xfffff000n);
  const minor = (device & 0xffn) | ((device >> 12n) & 0xffffff00n);
  return BigInt(`0x${record[2]}`) === major && BigInt(`0x${record[3]}`) === minor;
}

/** Require the live Linux flock inherited through exec; an environment flag cannot confer ownership. */
export async function requireWriterLock(stateParent: string): Promise<3> {
  if (process.platform !== "linux" || process.getuid === undefined || process.getuid() === 0) throw new Error("Hosted writer lock requires native non-root Linux under the reviewed service unit");
  const directory = await lstat(stateParent);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() || (directory.mode & 0o077) !== 0 || await realpath(stateParent) !== stateParent) {
    throw new Error("Hosted writer lock requires an owned, private, real state parent directory with mode 0700");
  }
  const lock = await lstat(path.join(stateParent, "writer.lock"), { bigint: true });
  if (!lock.isFile() || lock.isSymbolicLink() || lock.uid !== BigInt(process.getuid()) || (lock.mode & 0o077n) !== 0n || lock.nlink !== 1n) throw new Error("Hosted writer lock must be one owned, private regular file");
  // Read the kernel lock table atomically; enumerating Node's transient fdinfo entries races their closure.
  const locks = await readFile("/proc/locks", "utf8");
  if (!locks.split("\n").some((line: string): boolean => ownedLock(line, lock.dev, lock.ino, process.pid))) {
    throw new Error("Hosted writer lock is not held by this process. Start with the reviewed flock --nonblock --no-fork service unit; never bypass supervision");
  }
  // The reviewed unit opens no activation descriptors: flock owns fd 3, which every writer inherits.
  const descriptor = await stat("/proc/self/fd/3", { bigint: true });
  const info = await readFile("/proc/self/fdinfo/3", "utf8");
  if (descriptor.dev !== lock.dev || descriptor.ino !== lock.ino || !info.split("\n").some((line: string): boolean => ownedLock(line.replace(/^lock:\s+/, ""), lock.dev, lock.ino, process.pid))) {
    throw new Error("Hosted writer lock must be the verified inherited descriptor 3 supplied by the reviewed service unit");
  }
  return 3;
}
