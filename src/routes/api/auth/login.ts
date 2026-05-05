import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../../../db/client";
import { users } from "../../../db/schema";
import { verifyPassphrase } from "../../../lib/password";
import { signToken } from "../../../lib/auth";

const LoginBody = z.object({
  username: z.string().min(1),
  passphrase: z.string().min(1),
});

export const Route = createFileRoute("/api/auth/login")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await request.json();
        const parsed = LoginBody.safeParse(body);
        if (!parsed.success) {
          return Response.json(
            { error: "Missing username or passphrase" },
            { status: 400 }
          );
        }

        const { username, passphrase } = parsed.data;
        const [user] = await db
          .select()
          .from(users)
          .where(eq(users.username, username))
          .limit(1);

        if (!user) {
          return Response.json(
            { error: "Invalid username or passphrase" },
            { status: 401 }
          );
        }

        const valid = await verifyPassphrase(passphrase, user.passphraseHash);
        if (!valid) {
          return Response.json(
            { error: "Invalid username or passphrase" },
            { status: 401 }
          );
        }

        const token = await signToken({
          sub: String(user.id),
          username: user.username,
        });
        return Response.json({ token, username: user.username });
      },
    },
  },
});
