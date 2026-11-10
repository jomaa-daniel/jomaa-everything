// Must be imported before anything that loads matter.js, which reads these at
// import time. They are the defaults the standalone Matter server used, so the
// hub opens the same storage (data/native/matter-data or the Docker volume)
// that server created. Values set in the real environment still win.
process.env["MATTER_STORAGE_DRIVER"] ??= "wal";
process.env["MATTER_STORAGE_BLOBDRIVER"] ??= "dir";

export {};
