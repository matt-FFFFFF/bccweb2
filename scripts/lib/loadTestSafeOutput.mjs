// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const PRIVATE_MODE = 0o600;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY_FLAGS = constants.O_RDONLY | NOFOLLOW;
const EXISTING_FLAGS = constants.O_RDWR | NOFOLLOW;
const CREATE_FLAGS = EXISTING_FLAGS | constants.O_CREAT | constants.O_EXCL;
const READ_FLAGS = constants.O_RDONLY | NOFOLLOW;

function sameInode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertOwnedRegular(stat, label) {
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
  if (stat.nlink !== 1) throw new Error(`${label} must be a single-link file`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user`);
  }
}

async function openDirectoryChain(root, directory, files) {
  const relativePath = relative(root, directory);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("private output must remain inside the workspace root");
  }
  const paths = [root];
  let current = root;
  for (const component of relativePath.split(sep).filter(Boolean)) {
    current = resolve(current, component);
    paths.push(current);
  }
  const directories = [];
  try {
    for (const path of paths) directories.push({ path, handle: await files.open(path, DIRECTORY_FLAGS) });
    return directories;
  } catch (error) {
    await Promise.allSettled(directories.map(({ handle }) => handle.close()));
    throw error;
  }
}

async function verifyDirectories(directories, files) {
  for (const { path, handle } of directories) {
    const [opened, current] = await Promise.all([handle.stat(), files.lstat(path)]);
    if (!opened.isDirectory() || !current.isDirectory() || !sameInode(opened, current)) {
      throw new Error(`private output parent binding changed: ${path}`);
    }
  }
}

async function makeOutputDirectoryPrivate(directories) {
  const { handle } = directories.at(-1);
  const stat = await handle.stat();
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("private output directory must be owned by the current user");
  }
  await handle.chmod(0o700);
  await handle.sync();
}

async function inspectDestination(path, files) {
  let handle;
  try {
    handle = await files.open(path, EXISTING_FLAGS);
    const [opened, current] = await Promise.all([handle.stat(), files.lstat(path)]);
    assertOwnedRegular(opened, "private output destination");
    if (!current.isFile() || !sameInode(opened, current)) throw new Error("private output binding changed");
    await handle.chmod(PRIVATE_MODE);
    await handle.sync();
    return opened;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function openPrivateOutput(root, path, options = {}) {
  const files = { open, lstat, rename, unlink, ...options.files };
  const directories = await openDirectoryChain(root, dirname(path), files);
  let expectedDestination;
  let pending;

  const verifyDestination = async () => {
    await verifyDirectories(directories, files);
    let current;
    try {
      current = await files.lstat(path);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      current = null;
    }
    if (expectedDestination === null && current === null) return;
    if (expectedDestination === null || current === null || !sameInode(expectedDestination, current)) {
      throw new Error("private output binding changed");
    }
    assertOwnedRegular(current, "private output destination");
  };
  const verifyPending = async () => {
    await verifyDirectories(directories, files);
    const [opened, current] = await Promise.all([pending.handle.stat(), files.lstat(pending.path)]);
    assertOwnedRegular(opened, "private output temporary file");
    if (!current.isFile() || !sameInode(opened, current)) throw new Error("private output temporary binding changed");
    return opened;
  };
  const ensurePending = async () => {
    if (pending) return pending;
    const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
    pending = { path: tempPath, handle: await files.open(tempPath, CREATE_FLAGS, PRIVATE_MODE) };
    await verifyPending();
    return pending;
  };
  const discardPending = async () => {
    if (!pending) return;
    const discarded = pending;
    pending = null;
    await discarded.handle.close();
    await files.unlink(discarded.path).catch(() => undefined);
  };
  const publish = async () => {
    if (!pending) return;
    const publication = pending;
    const publishedStat = await verifyPending();
    await verifyDestination();
    await options.beforePublish?.();
    await verifyDestination();
    await files.rename(publication.path, path);
    expectedDestination = publishedStat;
    pending = null;
    await verifyDestination();
    await publication.handle.close();
  };

  try {
    await makeOutputDirectoryPrivate(directories);
    await verifyDirectories(directories, files);
    expectedDestination = await inspectDestination(path, files);
    await verifyDestination();
    return {
      get fd() { return pending?.handle.fd; },
      path,
      async verify() {
        if (pending) await verifyPending();
        else await verifyDestination();
      },
      async replace(content) {
        const { handle } = await ensurePending();
        await handle.truncate(0);
        await handle.write(content, 0, "utf8");
        await handle.chmod(PRIVATE_MODE);
        await handle.sync();
        await options.beforeReplace?.();
        await publish();
      },
      async prepareExternalWrite() {
        const { handle } = await ensurePending();
        await handle.truncate(0);
        await handle.chmod(PRIVATE_MODE);
        await handle.sync();
        await verifyPending();
        return handle.fd;
      },
      async readText() {
        if (!pending) throw new Error("private output has no pending descriptor");
        const stat = await verifyPending();
        const buffer = Buffer.alloc(stat.size);
        await pending.handle.read(buffer, 0, buffer.length, 0);
        await verifyPending();
        return buffer.toString("utf8");
      },
      async stat() {
        if (!pending) throw new Error("private output has no pending descriptor");
        return verifyPending();
      },
      async openReader() {
        if (!pending) throw new Error("private output has no pending descriptor");
        const writerStat = await verifyPending();
        const reader = await files.open(pending.path, READ_FLAGS);
        try {
          const readerStat = await reader.stat();
          assertOwnedRegular(readerStat, "private output reader");
          if (!sameInode(writerStat, readerStat)) throw new Error("private output reader binding changed");
          await verifyPending();
          return reader;
        } catch (error) {
          await reader.close();
          throw error;
        }
      },
      async close() {
        try {
          await publish();
        } catch (error) {
          await discardPending();
          throw error;
        } finally {
          await Promise.allSettled(directories.map(({ handle }) => handle.close()));
        }
      },
      async abort() {
        await discardPending();
        await Promise.allSettled(directories.map(({ handle }) => handle.close()));
      },
    };
  } catch (error) {
    await discardPending();
    await Promise.allSettled(directories.map(({ handle }) => handle.close()));
    throw error;
  }
}
