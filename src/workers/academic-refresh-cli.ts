import { MongoClient } from "mongodb";
import { loadOptions } from "../options.js";
import { initializeAcademicCollections } from "../plugins/academic-collections.js";
import { UstQuotaSource } from "../providers/ust-quota.js";
import { AcademicRefreshWorker } from "./academic-refresh.js";

const uri = Bun.env.MONGO_URI;
if (!uri || !/^mongodb(\+srv)?:\/\//.test(uri))
  throw new Error("MONGO_URI is required for the academic worker");
const client = new MongoClient(uri);
const options = loadOptions();
const databaseName =
  decodeURIComponent(new URL(uri).pathname.slice(1)) || "template-api";
await client.connect();
try {
  const db = client.db(databaseName);
  await initializeAcademicCollections(db);
  const provider = new UstQuotaSource({
    baseUrl: options.academicProviderBaseUrl,
  });
  let stopping = false;
  const worker = new AcademicRefreshWorker(db, provider, {
    maxAttempts: options.refreshMaxAttempts ?? 3,
    leaseSeconds: options.refreshLeaseSeconds ?? 60,
    failureCooldownSeconds: options.refreshFailureCooldownSeconds ?? 3600,
    quotaMinIntervalSeconds: options.academicQuotaMinIntervalSeconds ?? 300,
    quotaTtlSeconds: options.academicQuotaTtlSeconds ?? 900,
    maxWatchedJobsPerPoll: options.academicQuotaMaxJobsPerPoll ?? 100,
    shouldStop: () => stopping,
  });
  if (process.argv.includes("--once")) {
    await worker.runOne();
  } else {
    process.once("SIGINT", () => {
      stopping = true;
    });
    process.once("SIGTERM", () => {
      stopping = true;
    });
    while (!stopping) {
      const worked = await worker.runOne();
      if (!worked) await Bun.sleep(1000);
    }
  }
} finally {
  await client.close();
}
