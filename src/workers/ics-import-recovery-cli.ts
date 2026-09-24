import { MongoClient } from "mongodb";
import { loadOptions } from "../options.js";
import { IcsImportRecovery } from "./ics-import-recovery.js";

const uri = Bun.env.MONGO_URI;
if (!uri || !/^mongodb(?:\+srv)?:\/\//.test(uri))
  throw new Error("MONGO_URI is required for the ICS recovery worker");
const client = new MongoClient(uri);
const options = loadOptions();
const databaseName =
  decodeURIComponent(new URL(uri).pathname.slice(1)) || "template-api";
await client.connect();
try {
  const db = client.db(databaseName);
  const recovered = await new IcsImportRecovery(
    db.collection("eventImports"),
    db.collection("events"),
    options.icsImportRecoveryGraceSeconds ?? 3600,
  ).runOnce();
  console.log(JSON.stringify({ recovered }));
} finally {
  await client.close();
}
