import * as path from "node:path";
import { fileURLToPath } from "node:url";
import AutoLoad from "@fastify/autoload";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import scalarApiReference from "@scalar/fastify-api-reference";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyPluginAsync,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import packageJson from "../package.json" with { type: "json" };
import { type AppOptions, options } from "./options.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Support Typebox
export type FastifyTypebox = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression<RawServerDefault>,
  RawReplyDefaultExpression<RawServerDefault>,
  FastifyBaseLogger,
  TypeBoxTypeProvider
>;

/**
 * Builds the Fastify application.
 *
 * Cross-cutting plugins are autoloaded from `src/plugins` (MongoDB, auth,
 * sensible), route services from `src/routes`. Swagger documents the API at
 * `/documentation` and Scalar renders it at `/reference`.
 */
const app: FastifyPluginAsync<AppOptions> = async (
  fastify,
  opts,
): Promise<void> => {
  // Place here your custom code!

  // Register CORS
  await fastify.register(cors, {
    origin: "*",
  });

  // Register Swagger & Swagger UI & Scalar
  await fastify.register(swagger, {
    openapi: {
      info: {
        title: packageJson.name,
        description: packageJson.description,
        version: packageJson.version,
      },
      servers: [
        {
          url: "http://localhost:3000",
          description: "Local Server",
        },
      ],
      tags: [
        { name: "Example", description: "Example endpoints" },
        { name: "Auth", description: "Auth endpoints" },
        { name: "Events", description: "User-owned timetable events" },
        {
          name: "Calendar",
          description: "Timetable occurrences and conflicts",
        },
        {
          name: "Academic",
          description: "Academic terms, courses, sections and quota",
        },
        { name: "Watching", description: "Quota watches and notifications" },
      ],
      components: {
        securitySchemes: {
          Auth: {
            type: "http",
            scheme: "bearer",
          },
        },
      },
    },
    refResolver: {
      buildLocalReference(json, _baseUri, _fragment, i) {
        return (json.$id as string) || `def-${i}`;
      },
    },
  });
  await fastify.register(swaggerUi);
  await fastify.register(scalarApiReference);

  // Do not touch the following lines

  // This loads all plugins defined in plugins
  // those should be support plugins that are reused
  // through your application
  void fastify.register(AutoLoad, {
    dir: path.join(__dirname, "plugins"),
    options: opts,
    forceESM: true,
  });

  // This loads all plugins defined in routes
  // define your routes in one of these
  void fastify.register(AutoLoad, {
    dir: path.join(__dirname, "routes"),
    options: opts,
    forceESM: true,
  });
};

export default app;
export { app, options };
