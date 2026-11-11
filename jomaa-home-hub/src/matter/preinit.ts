// Must be imported before anything that loads matter.js, which reads these at
// import time. They select the storage format of the hub's Matter storage
// directory. Values set in the real environment win.
process.env["MATTER_STORAGE_DRIVER"] ??= "wal";
process.env["MATTER_STORAGE_BLOBDRIVER"] ??= "dir";

export {};
