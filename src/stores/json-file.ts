import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { InMemoryStore, type MemoryState } from "./in-memory.js";
import { fail, id, json, object } from "../utils.js";
import { stored } from "../validation.js";
import type { Collection, Collections } from "../contracts.js";
const owners = new Set<string>();
/** Explicit copy-only v2 -> v3 migration. The original and existing destination are never overwritten. */
export async function migrateJsonV2(source:string,destination:string):Promise<void>{
  if(resolve(source)===resolve(destination))fail('invalid_input','Migration requires a different destination.');
  const input=JSON.parse(await readFile(source,'utf8'));
  json(input,128*1024*1024);object(input,'JSON export');
  if(input.version!==2)fail('migration_required','Expected a v2 JSON store.');
  object(input.namespaces,'namespaces');
  for(const [namespace,buckets] of Object.entries(input.namespaces)){
    object(buckets,'collections');
    for(const [kind,rows] of Object.entries(buckets)){
      if(!['executions','signals','candidates','targets','attempts','events','historical'].includes(kind))fail('migration_required','Unknown v2 collection.');
      object(rows,'records');for(const [key,row] of Object.entries(rows)){stored(kind as Collection,row as unknown as Collections[Collection],namespace);if((row as {id:string}).id!==key)fail('integrity_error','Record key does not match its ID.');}
    }
  }
  const file=await open(destination,'wx',0o600);
  try{await file.writeFile(JSON.stringify({...input,version:3}));await file.sync();}finally{await file.close();}
}
/** Development only: one instance per path per process; no inter-process locking. */
export class JsonFileStore extends InMemoryStore {
  readonly filePath: string;
  private loaded = false;
  private closed = false;
  constructor(path: string) {
    super();
    this.filePath = resolve(path);
    if (owners.has(this.filePath))
      fail("store_in_use", "JSON store path already open in this process.");
    owners.add(this.filePath);
  }
  protected override async load(): Promise<void> {
    if (this.closed) fail("store_closed", "Store is closed.");
    if (this.loaded) return;
    try {
      const document = JSON.parse(await readFile(this.filePath, "utf8")) as {
        version: number;
        namespaces: MemoryState;
      };
      json(document, 128 * 1024 * 1024);
      if (
        document.version !== 3 ||
        !document.namespaces ||
        Array.isArray(document.namespaces)
      )
        fail(
          "migration_required",
          "Expected v3 JSON. Explicitly migrate a copy; preserve the original file.",
        );
      this.state = Object.assign(
        Object.create(null),
        document.namespaces,
      ) as MemoryState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.loaded = true;
  }
  protected override async persist(next: MemoryState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${id("write")}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify({ version: 3, namespaces: next }));
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, this.filePath);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  override async close(): Promise<void> {
    await super.close();
    this.closed = true;
    owners.delete(this.filePath);
  }
}
