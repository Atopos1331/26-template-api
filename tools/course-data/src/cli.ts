import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { MongoClient } from "mongodb";
import type { CourseData } from "./contract.ts";
import { validate } from "./contract.ts";
import { BoundedClient } from "./fetch/client.ts";
import { normalize } from "./normalize/index.ts";
import { loadBatch, rollbackBatch } from "./output/mongo-loader.ts";
import { fetchTerm, type RawImport } from "./providers/ust-schedule.ts";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function withDatabase<T>(
  run: (client: MongoClient) => Promise<T>,
): Promise<T> {
  const uri = Bun.env.MONGO_URI;
  if (!uri || !/^mongodb(\+srv)?:\/\//.test(uri))
    throw new Error("MONGO_URI_REQUIRED");
  const client = new MongoClient(uri);
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

function databaseName(): string {
  const uri = Bun.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI_REQUIRED");
  const path = new URL(uri).pathname.slice(1);
  return path ? decodeURIComponent(path) : "template-api";
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const term = option("term");
  if (command === "fetch" || command === "refresh") {
    if (!term) throw new Error("TERM_REQUIRED");
    const client = new BoundedClient();
    const raw = await fetchTerm(client, term, option("subject"));
    const rawPath = resolve(
      option("raw-output") ?? `data/raw/${term}-${Date.now()}.json`,
    );
    await writeJson(rawPath, raw);
    if (command === "fetch") {
      console.log(JSON.stringify({ subjects: raw.pages.length, rawPath }));
      return;
    }
    const data = normalize(raw);
    const batchId = await withDatabase((connection) =>
      loadBatch(connection.db(databaseName()), data, {
        trigger: "scheduled",
        allowDestructiveReconciliation: process.argv.includes(
          "--allow-destructive-reconciliation",
        ),
      }),
    );
    console.log(
      JSON.stringify({
        batchId,
        courses: data.courses.length,
        sections: data.sections.length,
        warnings: data.warnings?.length ?? 0,
      }),
    );
    return;
  }
  if (command === "normalize") {
    const input = option("input");
    if (!input) throw new Error("INPUT_REQUIRED");
    const data = normalize((await readJson(input)) as RawImport);
    const output = resolve(
      option("output") ??
        `data/normalized/${data.term.termCode}-${Date.now()}.json`,
    );
    await writeJson(output, data);
    console.log(
      JSON.stringify({
        output,
        courses: data.courses.length,
        sections: data.sections.length,
        warnings: data.warnings?.length ?? 0,
      }),
    );
    return;
  }
  if (command === "fixture") {
    const input = option("input");
    const output = option("output");
    if (!input || !output) throw new Error("INPUT_OUTPUT_REQUIRED");
    const data = await readJson(input);
    validate(data);
    const first = data.offerings[0];
    if (!first) throw new Error("FIXTURE_EMPTY");
    const sections = data.sections.filter(
      (row) => row.offeringId === first.offeringId,
    );
    const ids = new Set(sections.map((row) => row.sectionId));
    const fixture: CourseData = {
      ...data,
      termMetadataCoverage: "unavailable",
      isCompleteSnapshot: false,
      sourceRecordCount: 1,
      resourceCoverage: {
        courses: "partial",
        offerings: "partial",
        sections: "partial",
        bundles: "partial",
      },
      courses: data.courses
        .filter((row) => row.courseId === first.courseId)
        .map((row) => ({ ...row, attributes: {} })),
      offerings: [first],
      sections,
      bundles: data.bundles.filter(
        (row) => row.offeringId === first.offeringId,
      ),
      quotaSnapshots: data.quotaSnapshots.filter((row) =>
        ids.has(row.sectionId),
      ),
      warnings: [],
    };
    validate(fixture);
    await writeJson(resolve(output), fixture);
    console.log(JSON.stringify({ output: resolve(output), courses: 1 }));
    return;
  }
  if (command === "load") {
    const input = option("input");
    if (!input) throw new Error("INPUT_REQUIRED");
    const data = await readJson(input);
    validate(data);
    const batchId = await withDatabase((connection) =>
      loadBatch(connection.db(databaseName()), data, {
        importBatchId: option("batch"),
        allowDestructiveReconciliation: process.argv.includes(
          "--allow-destructive-reconciliation",
        ),
      }),
    );
    console.log(JSON.stringify({ batchId }));
    return;
  }
  if (command === "rollback") {
    const batchId = option("batch");
    if (!term || !batchId) throw new Error("TERM_BATCH_REQUIRED");
    await withDatabase((connection) =>
      rollbackBatch(
        connection.db(databaseName()),
        "ust-class-schedule",
        term,
        batchId,
      ),
    );
    console.log(JSON.stringify({ activeImportBatchId: batchId }));
    return;
  }
  throw new Error("COMMAND_UNKNOWN");
}

await main().catch((error) => {
  const code =
    error instanceof Error && /^[A-Z_]+$/.test(error.message)
      ? error.message
      : "COURSE_DATA_FAILED";
  console.error(code);
  process.exitCode = 1;
});
