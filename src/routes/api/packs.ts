import { createFileRoute } from "@tanstack/react-router";
import { db } from "../../db/client";
import { packs } from "../../db/schema";
import { asc } from "drizzle-orm";

export const Route = createFileRoute("/api/packs")({
  server: {
    handlers: {
      GET: async () => {
        const all = await db
          .select({ id: packs.id, name: packs.name })
          .from(packs)
          .orderBy(asc(packs.name));
        return Response.json(all);
      },
    },
  },
});
