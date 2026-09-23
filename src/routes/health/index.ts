import type { FastifyPluginAsync } from "fastify";
import { Type } from "typebox";
import type { FastifyTypebox } from "../../app.js";

const health: FastifyPluginAsync = async (fastify: FastifyTypebox) => {
  fastify.get(
    "/",
    {
      schema: {
        summary: "Check API and database readiness",
        response: {
          200: Type.Object({ status: Type.Literal("ok") }),
          503: Type.Object({ status: Type.Literal("unavailable") }),
        },
      },
    },
    async (_request, reply) => {
      try {
        if (!fastify.mongo.db) throw new Error("Database unavailable");
        await fastify.mongo.db.admin().ping();
        return { status: "ok" as const };
      } catch {
        return reply.code(503).send({ status: "unavailable" as const });
      }
    },
  );
};

export default health;
